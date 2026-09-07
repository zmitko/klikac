const { execFile } = require("child_process");

class PcPing {
  constructor(host, name) {
    this.host = host || "";
    this.name = name || "PC";
    this.online = false;
    this.lastOkAt = 0;
    this.lastCheckAt = 0;
    this.timer = null;
  }

  start(onChange) {
    if (!this.host) {
      return;
    }
    const tick = () => this.check().then(() => onChange && onChange(this.snapshot()));
    tick();
    this.timer = setInterval(tick, 15000);
  }

  snapshot() {
    return {
      host: this.host,
      name: this.name,
      online: this.online,
      lastOkAt: this.lastOkAt,
      lastCheckAt: this.lastCheckAt,
    };
  }

  check() {
    return new Promise((resolve) => {
      if (!this.host) {
        resolve();
        return;
      }
      const args = process.platform === "win32"
        ? ["-n", "1", "-w", "1000", this.host]
        : ["-c", "1", "-W", "1", this.host];
      execFile("ping", args, { windowsHide: true, timeout: 4000 }, (err) => {
        this.lastCheckAt = Date.now();
        this.online = !err;
        if (this.online) {
          this.lastOkAt = this.lastCheckAt;
        }
        resolve();
      });
    });
  }
}

module.exports = { PcPing };
