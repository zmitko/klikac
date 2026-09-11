const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

class MouseBridge {
  constructor({ onClick }) {
    this.onClick = onClick;
    this.enabled = false;
    this.child = null;
    this.buf = "";
    this.lastClick = "";
    this.lastClickAt = 0;
    this.hookPid = 0;
    this.lastError = "";
    this.allowLmb = true;
    this.allowRmb = true;
  }

  status() {
    return {
      enabled: this.enabled,
      available: true,
      running: !!(this.child && this.child.pid),
      hookPid: this.hookPid,
      lastClick: this.lastClick,
      lastClickAt: this.lastClickAt,
      lastError: this.lastError,
      mode: "global",
      allowLmb: this.allowLmb,
      allowRmb: this.allowRmb,
    };
  }

  setButtons({ lmb, rmb }) {
    if (lmb !== undefined) {
      this.allowLmb = !!lmb;
    }
    if (rmb !== undefined) {
      this.allowRmb = !!rmb;
    }
    return this.status();
  }

  setEnabled(on) {
    const want = !!on;
    if (want === this.enabled && (!want || this.child)) {
      return this.status();
    }
    this.enabled = want;
    if (want) {
      this.startHook();
    } else {
      this.stopHook();
    }
    return this.status();
  }

  localPaths() {
    const localDir = path.join(process.env.LOCALAPPDATA || process.env.TEMP, "klikac");
    fs.mkdirSync(localDir, { recursive: true });
    return {
      localDir,
      exe: path.join(localDir, "mouse-hook.exe"),
      localSrc: path.join(localDir, "mouse-hook.cs"),
      src: path.join(__dirname, "..", "tools", "mouse-hook.cs"),
    };
  }

  ensureExe() {
    const { exe, src, localSrc } = this.localPaths();
    if (!fs.existsSync(src)) {
      throw new Error("Chybí mouse-hook.cs");
    }
    fs.copyFileSync(src, localSrc);
    const srcStat = fs.statSync(localSrc);
    if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= srcStat.mtimeMs) {
      return exe;
    }
    if (!fs.existsSync(CSC)) {
      throw new Error("Nelze zkompilovat mouse-hook (chybí csc.exe)");
    }
    execFileSync(CSC, ["/nologo", "/optimize+", `/out:${exe}`, localSrc], {
      windowsHide: true,
      timeout: 20000,
    });
    return exe;
  }

  startHook() {
    this.stopHook();
    this.buf = "";
    this.lastError = "";
    let exe;
    try {
      exe = this.ensureExe();
    } catch (err) {
      this.lastError = err.message;
      console.error("mouse-hook compile:", err.message);
      this.enabled = false;
      return;
    }
    this.child = spawn(exe, [], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.hookPid = this.child.pid || 0;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.lastError = String(chunk).trim();
      console.error("mouse-hook:", this.lastError);
    });
    this.child.on("error", (err) => {
      this.lastError = err.message;
      console.error("mouse-hook spawn:", err.message);
    });
    this.child.on("exit", (code) => {
      this.child = null;
      this.hookPid = 0;
      if (this.enabled) {
        this.lastError = `hook exit ${code}`;
        setTimeout(() => {
          if (this.enabled && !this.child) {
            this.startHook();
          }
        }, 800);
      }
    });
  }

  onData(chunk) {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop();
    for (const line of parts) {
      const token = line.trim();
      if (token === "LC" && !this.allowLmb) {
        continue;
      }
      if (token === "RC" && !this.allowRmb) {
        continue;
      }
      if (token !== "LC" && token !== "RC") {
        continue;
      }
      this.lastClick = token;
      this.lastClickAt = Date.now();
      try {
        this.onClick(token);
      } catch (err) {
        this.lastError = err.message || "MQTT publish selhal";
      }
    }
  }

  stopHook() {
    if (!this.child) {
      return;
    }
    const proc = this.child;
    this.child = null;
    this.hookPid = 0;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }

  handlePageClick(button) {
    if (!this.enabled) {
      return { ok: false, reason: "mouse_bridge_off" };
    }
    const payload = button === "right" || button === "RC" || button === "RMB" ? "RC" : "LC";
    if ((payload === "LC" && !this.allowLmb) || (payload === "RC" && !this.allowRmb)) {
      return { ok: false, reason: "mouse_button_off" };
    }
    this.lastClick = payload;
    this.lastClickAt = Date.now();
    this.onClick(payload);
    return { ok: true, payload };
  }
}

module.exports = { MouseBridge };
