const { app, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { fetchLatestRelease, downloadFile, cmpVersion } = require("./githubRelease");

class AppUpdater {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.busy = false;
    this.state = {
      current: app.getVersion(),
      latest: "",
      available: false,
      notes: "",
      htmlUrl: "",
      installerUrl: "",
      error: "",
      progress: 0,
      status: "idle",
    };
    this.autoUpdater = null;
  }

  snapshot() {
    return { ...this.state, packaged: app.isPackaged };
  }

  emit() {
    if (typeof this.onChange === "function") {
      this.onChange();
    }
  }

  cacheDir() {
    const dir = path.join(app.getPath("userData"), "updates");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  start() {
    if (app.isPackaged) {
      try {
        const { autoUpdater } = require("electron-updater");
        this.autoUpdater = autoUpdater;
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.on("update-available", (info) => {
          this.state.latest = info.version;
          this.state.available = cmpVersion(info.version, this.state.current) > 0;
          this.state.status = "available";
          this.emit();
        });
        autoUpdater.on("update-not-available", () => {
          this.state.available = false;
          this.state.status = "ok";
          this.emit();
        });
        autoUpdater.on("download-progress", (p) => {
          this.state.progress = (p.percent || 0) / 100;
          this.state.status = "downloading";
          this.emit();
        });
        autoUpdater.on("update-downloaded", () => {
          this.state.status = "ready";
          this.state.progress = 1;
          this.emit();
        });
        autoUpdater.on("error", (err) => {
          this.state.error = err.message;
          this.state.status = "error";
          this.emit();
        });
      } catch (err) {
        this.state.error = err.message;
      }
    }
    this.check().catch(() => {});
  }

  async check() {
    this.state.error = "";
    this.state.status = "checking";
    this.emit();
    try {
      if (this.autoUpdater) {
        await this.autoUpdater.checkForUpdates();
      }
      const latest = await fetchLatestRelease();
      this.state.latest = latest.version;
      this.state.notes = latest.notes;
      this.state.htmlUrl = latest.htmlUrl;
      this.state.installerUrl = latest.installerUrl;
      this.state.available = cmpVersion(latest.version, this.state.current) > 0;
      if (this.state.status === "checking") {
        this.state.status = this.state.available ? "available" : "ok";
      }
      this.emit();
      return this.snapshot();
    } catch (err) {
      if (/404|Not Found/i.test(String(err.message))) {
        this.state.available = false;
        this.state.status = "ok";
        this.state.error = "";
        this.emit();
        return this.snapshot();
      }
      this.state.error = err.message;
      this.state.status = "error";
      this.emit();
      return this.snapshot();
    }
  }

  async install() {
    if (this.busy) {
      return this.snapshot();
    }
    if (!this.state.available && this.state.status !== "ready") {
      await this.check();
    }
    if (!this.state.available && this.state.status !== "ready") {
      throw new Error("Žádná nová verze Klikače");
    }
    this.busy = true;
    this.state.error = "";
    try {
      if (this.autoUpdater && app.isPackaged) {
        this.state.status = "downloading";
        this.emit();
        await this.autoUpdater.downloadUpdate();
        this.autoUpdater.quitAndInstall(false, true);
        return this.snapshot();
      }
      if (!this.state.installerUrl) {
        if (this.state.htmlUrl) {
          await shell.openExternal(this.state.htmlUrl);
        }
        throw new Error("Instalátor v releasu ještě není. Otevřel jsem GitHub.");
      }
      const dest = path.join(this.cacheDir(), `Klikac-Setup-${this.state.latest}.exe`);
      this.state.status = "downloading";
      this.emit();
      await downloadFile(this.state.installerUrl, dest, (p) => {
        this.state.progress = p;
        this.emit();
      });
      this.state.status = "installing";
      this.emit();
      const child = spawn(dest, [], { detached: true, stdio: "ignore" });
      child.unref();
      app.quit();
      return this.snapshot();
    } catch (err) {
      this.state.error = err.message;
      this.state.status = "error";
      this.emit();
      throw err;
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { AppUpdater };
