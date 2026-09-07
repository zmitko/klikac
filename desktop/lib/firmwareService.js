const { app } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { createReadStream } = require("fs");
const { fetchLatestRelease, downloadFile, cmpVersion } = require("./githubRelease");
const { pushFirmware } = require("./espota");
const { listSerialPorts, pickFlashPort } = require("./serialPorts");
const { otaTopic } = require("./releaseMeta");
const { lanIPv4 } = require("./lan");
const { provisionSerial } = require("./serialProvision");
const { OTA_PASSWORD } = require("./mqttCreds");

class FirmwareService {
  constructor({ mqtt, otaPassword, onChange, onLog }) {
    this.mqtt = mqtt;
    this.otaPassword = otaPassword || OTA_PASSWORD;
    this.onChange = onChange;
    this.onLog = onLog;
    this.busy = false;
    this.state = {
      current: "",
      latest: "",
      available: false,
      method: "",
      progress: 0,
      status: "idle",
      error: "",
      log: "",
      ports: [],
    };
  }

  snapshot() {
    const device = this.mqtt.snapshot();
    this.state.current = device.fw || this.state.current;
    return { ...this.state };
  }

  emit() {
    if (typeof this.onChange === "function") {
      this.onChange();
    }
  }

  setLog(msg) {
    this.state.log = msg;
    if (typeof this.onLog === "function") {
      this.onLog("usb", msg);
    }
    this.emit();
  }

  cacheDir() {
    const dir = path.join(app.getPath("userData"), "firmware");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  bundledFile(name) {
    const roots = [];
    if (process.resourcesPath) {
      roots.push(path.join(process.resourcesPath, "firmware"));
      roots.push(path.join(process.resourcesPath, "tools"));
    }
    roots.push(path.join(__dirname, "..", "firmware"));
    roots.push(path.join(__dirname, "..", "tools"));
    roots.push(path.join(__dirname, "..", "..", ".pio", "build", "esp32-s3-n16r8"));
    for (const root of roots) {
      const full = path.join(root, name);
      if (fs.existsSync(full)) {
        return full;
      }
    }
    return "";
  }

  async ensureAsset(url, fileName) {
    const bundled = this.bundledFile(fileName);
    if (bundled) {
      return bundled;
    }
    if (!url) {
      throw new Error(`Chybí ${fileName} v GitHub releasu`);
    }
    const dest = path.join(this.cacheDir(), fileName);
    await downloadFile(url, dest, (p) => {
      this.state.progress = p;
      this.state.status = "downloading";
      this.emit();
    });
    return dest;
  }

  async check() {
    this.state.error = "";
    try {
      const latest = await fetchLatestRelease();
      this.state.latest = latest.version;
      const deviceFw = this.mqtt.snapshot().fw || "";
      this.state.current = deviceFw;
      this.state.available = !deviceFw || cmpVersion(latest.version, deviceFw) > 0;
      this.state.status = this.state.available ? "available" : "ok";
      this.emit();
      return { latest, snapshot: this.snapshot() };
    } catch (err) {
      if (/404|Not Found/i.test(String(err.message))) {
        this.state.available = false;
        this.state.status = "ok";
        this.state.error = "";
        this.emit();
        return { latest: null, snapshot: this.snapshot() };
      }
      this.state.error = err.message;
      this.state.status = "error";
      this.emit();
      throw err;
    }
  }

  async resolveImages() {
    let latest;
    try {
      latest = (await this.check()).latest;
    } catch (err) {
      latest = null;
      this.setLog(`GitHub: ${err.message}. Zkusím lokální soubor.`);
    }
    const firmwareBin = latest
      ? await this.ensureAsset(latest.firmwareBinUrl, "firmware.bin")
      : this.bundledFile("firmware.bin");
    if (!firmwareBin) {
      throw new Error("firmware.bin není k dispozici. Nejdřív vydaj release, nebo zkompiluj PlatformIO.");
    }
    const factoryBin = latest && latest.factoryUrl
      ? await this.ensureAsset(latest.factoryUrl, "firmware-factory.bin")
      : (this.bundledFile("firmware-factory.bin") || "");
    const elf = latest && latest.firmwareElfUrl
      ? await this.ensureAsset(latest.firmwareElfUrl, "firmware.elf")
      : this.bundledFile("firmware.elf");
    return { firmwareBin, factoryBin, elf };
  }

  async flash(opts = {}) {
    if (this.busy) {
      throw new Error("Nahrávání už běží");
    }
    const wifiSsid = String(opts.wifiSsid || "").trim();
    const wifiPassword = String(opts.wifiPassword || "");
    const mqttHost = String(opts.mqttHost || lanIPv4()).trim();
    this.busy = true;
    this.state.error = "";
    this.state.progress = 0;
    this.state.method = "usb";
    this.state.status = "preparing";
    this.setLog("Připravuji USB inicializaci…");
    try {
      if (!wifiSsid) {
        throw new Error("Vyplň Wi-Fi SSID před USB inicializací.");
      }
      if (!mqttHost) {
        throw new Error("Neznám IP tohoto PC. Připoj PC1 na LAN.");
      }
      const { firmwareBin, factoryBin, elf } = await this.resolveImages();
      const usbImage = elf || factoryBin || firmwareBin;
      const ports = await listSerialPorts();
      this.state.ports = ports;
      const port = pickFlashPort(ports);
      if (!port) {
        throw new Error("Flash kabel (CH343/COM) na tomhle PC není. USB init dělej na PC1 s programovacím USB.");
      }
      this.setLog(`USB ${port.path} (${port.name || "sériový port"}). Drž BOOT, pokud deska neskáče do flashe.`);
      await this.flashUsb({
        port: port.path,
        image: usbImage,
      });
      this.setLog("Firmware nahraný. Posílám Wi-Fi a IP Klikače…");
      this.state.status = "uploading";
      await new Promise((r) => setTimeout(r, 3500));
      await provisionSerial({
        port: port.path,
        wifiSsid,
        wifiPassword,
        mqttHost,
        onLine: (line) => this.setLog(line),
      });
      this.state.status = "ok";
      this.state.progress = 1;
      this.setLog(`Hotovo. MQTT broker ${mqttHost}:1883. Přepoj destičku USB do PC2.`);
      return this.snapshot();
    } catch (err) {
      this.state.error = err.message;
      this.state.status = "error";
      this.setLog(err.message);
      throw err;
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  async ota() {
    if (this.busy) {
      throw new Error("Nahrávání už běží");
    }
    this.busy = true;
    this.state.error = "";
    this.state.progress = 0;
    this.state.method = "wifi";
    this.state.status = "preparing";
    this.setLog("Připravuji firmware přes Wi-Fi…");
    try {
      const ip = this.mqtt.snapshot().ip;
      if (!ip) {
        throw new Error("Destička není online. Nech ji na Wi-Fi u PC2, Klikač na PC1.");
      }
      const { firmwareBin } = await this.resolveImages();
      this.setLog(`Wi-Fi OTA na ${ip}…`);
      try {
        await pushFirmware({
          host: ip,
          password: this.otaPassword,
          filePath: firmwareBin,
          onProgress: (p) => {
            this.state.progress = p;
            this.state.status = "uploading";
            this.emit();
          },
        });
        this.state.status = "ok";
        this.state.progress = 1;
        this.setLog("Firmware nahraný přes Wi-Fi (ArduinoOTA). Destička se restartuje.");
        return this.snapshot();
      } catch (otaErr) {
        this.setLog(`ArduinoOTA selhalo (${otaErr.message}). Destička si ho stáhne z Klikače…`);
        await this.flashHttp(firmwareBin);
        this.state.status = "ok";
        this.state.progress = 1;
        this.setLog("Odkaz na firmware odeslán. Po restartu destičky zkontroluj verzi.");
        return this.snapshot();
      }
    } catch (err) {
      this.state.error = err.message;
      this.state.status = "error";
      this.setLog(err.message);
      throw err;
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  async flashUsb({ port, image }) {
    let espflash = this.bundledFile("espflash.exe") || path.join(this.cacheDir(), "espflash.exe");
    if (!fs.existsSync(espflash)) {
      this.setLog("Stahuji espflash…");
      let url = "";
      try {
        const latest = await fetchLatestRelease();
        url = latest.espflashUrl;
      } catch {
        url = "";
      }
      if (!url) {
        url = "https://github.com/esp-rs/espflash/releases/download/v4.5.0/espflash-x86_64-pc-windows-msvc.zip";
      }
      if (url.endsWith(".zip")) {
        const zip = path.join(this.cacheDir(), "espflash.zip");
        await downloadFile(url, zip);
        const { execFile } = require("child_process");
        const { promisify } = require("util");
        await promisify(execFile)("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path "${zip}" -DestinationPath "${this.cacheDir()}" -Force`,
        ], { windowsHide: true });
        const found = path.join(this.cacheDir(), "espflash.exe");
        if (!fs.existsSync(found)) {
          throw new Error("espflash.exe se z archivu nenašel");
        }
        espflash = found;
      } else {
        await downloadFile(url, espflash);
      }
    }
    const ext = path.extname(image).toLowerCase();
    const base = path.basename(image).toLowerCase();
    let args;
    if (ext === ".elf") {
      args = ["flash", "--port", port, "--baud", "921600", "--flash-size", "16mb", image];
    } else if (base.includes("factory")) {
      args = ["write-bin", "--port", port, "--baud", "921600", "0x0", image];
    } else {
      args = ["write-bin", "--port", port, "--baud", "921600", "0x10000", image];
    }
    await this.runProcess(espflash, args);
  }

  runProcess(cmd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true });
      let err = "";
      child.stdout.on("data", (chunk) => {
        const line = String(chunk).trim();
        if (line) {
          this.setLog(line.slice(-180));
        }
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
        const line = String(chunk).trim();
        if (line) {
          this.setLog(line.slice(-180));
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(err.trim() || `espflash skončil kódem ${code}`));
        }
      });
    });
  }

  async flashHttp(firmwareBin) {
    if (!this.mqtt.isReady()) {
      throw new Error("MQTT není připojený, destička si firmware nestáhne");
    }
    const ip = lanIPv4();
    if (!ip) {
      throw new Error("PC1 nemá LAN IP pro HTTP OTA");
    }
    const url = await this.serveFile(firmwareBin, ip);
    this.mqtt.publish(otaTopic, url);
    this.setLog(`Odesláno destičce: ${url}`);
  }

  serveFile(filePath, ip) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        if (req.url !== "/firmware.bin") {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(filePath).size);
        try {
          await pipeline(createReadStream(filePath), res);
        } catch {
          /* client hangup */
        }
        setTimeout(() => server.close(), 2000);
      });
      server.on("error", reject);
      server.listen(0, "0.0.0.0", () => {
        const { port } = server.address();
        resolve(`http://${ip}:${port}/firmware.bin`);
      });
    });
  }
}

module.exports = { FirmwareService };
