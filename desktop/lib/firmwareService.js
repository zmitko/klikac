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
const { diagnoseSerial } = require("./serialDiagnose");
const { OTA_PASSWORD } = require("./mqttCreds");
const { OTA_HTTP_PORT } = require("./klikacPorts");
const { buildCfgFlash, CFG_FLASH_ADDRS } = require("./cfgFlashBlob");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    roots.push(path.join(__dirname, "..", "..", ".pio", "build", "esp32-s3-n16r8"));
    if (process.resourcesPath) {
      roots.push(path.join(process.resourcesPath, "firmware"));
      roots.push(path.join(process.resourcesPath, "tools"));
    }
    roots.push(path.join(__dirname, "..", "firmware"));
    roots.push(path.join(__dirname, "..", "tools"));
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

  async resolveImages(opts = {}) {
    const bundledBin = this.bundledFile("firmware.bin");
    if (opts.otaOnly && bundledBin) {
      return { firmwareBin: bundledBin, factoryBin: "", elf: "", version: "" };
    }
    let latest;
    try {
      latest = (await this.check()).latest;
    } catch (err) {
      latest = null;
      this.setLog(`GitHub: ${err.message}. Zkusím lokální soubor.`);
    }
    const firmwareBin = latest
      ? await this.ensureAsset(latest.firmwareBinUrl, "firmware.bin")
      : bundledBin;
    if (!firmwareBin) {
      throw new Error("firmware.bin není k dispozici. Nejdřív vydaj release, nebo zkompiluj PlatformIO.");
    }
    if (opts.otaOnly) {
      return { firmwareBin, factoryBin: "", elf: "", version: latest ? latest.version : "" };
    }
    const factoryBin = latest && latest.factoryUrl
      ? await this.ensureAsset(latest.factoryUrl, "firmware-factory.bin")
      : (this.bundledFile("firmware-factory.bin") || "");
    const elf = latest && latest.firmwareElfUrl
      ? await this.ensureAsset(latest.firmwareElfUrl, "firmware.elf")
      : this.bundledFile("firmware.elf");
    return { firmwareBin, factoryBin, elf, version: latest ? latest.version : "" };
  }

  async flash(opts = {}) {
    if (this.busy) {
      throw new Error("Nahrávání už běží");
    }
    const wifiSsid = String(opts.wifiSsid || "").trim();
    const wifiPassword = String(opts.wifiPassword || "");
    const mqttHost = String(opts.mqttHost || lanIPv4()).trim();
    const force = !!opts.force;
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
        throw new Error("Vyplň IP (PC1 kde běží Klikač) pod tlačítkem.");
      }
      const ports = await listSerialPorts();
      this.state.ports = ports;
      const port = pickFlashPort(ports);
      if (!port) {
        throw new Error("Flash kabel (CH343/COM) na tomhle PC není. USB init dělej na PC1 s programovacím USB.");
      }
      const sendCfg = (serialForce) => provisionSerial({
        port: port.path,
        wifiSsid,
        wifiPassword,
        mqttHost,
        force: !!serialForce,
        onLine: (line) => this.setLog(line),
      });
      const flashFw = async (why) => {
        this.setLog(why);
        this.state.status = "preparing";
        const { firmwareBin, factoryBin, elf, version } = await this.resolveImages();
        const usbImage = elf || factoryBin || firmwareBin;
        this.setLog(`Nahrávám ${path.basename(usbImage)}${version ? ` ${version}` : ""}`);
        this.setLog(`USB ${port.path} (${port.name || "sériový port"}). Drž BOOT, pokud deska neskáče do flashe.`);
        await this.flashUsb({
          port: port.path,
          image: usbImage,
        });
        this.state.status = "uploading";
        await sleep(4000);
      };
      const writeFlashOnly = async () => {
        await this.writeCfgFlash({
          port: port.path,
          wifiSsid,
          wifiPassword,
          mqttHost,
        });
        this.setLog("Síť je ve flash. Sériový FORCE neposílám — ten by zápis mohl smazat.");
      };
      if (force) {
        await flashFw("Vynucený zápis: nahrávám firmware…");
        try {
          await writeFlashOnly();
        } catch (flashErr) {
          this.setLog(`Přímý zápis do flash selhal (${flashErr.message}). Zkouším sériový FORCE…`);
          await sendCfg(true);
        }
      } else {
        this.state.status = "uploading";
        this.setLog(`COM ${port.path}. Posílám Wi-Fi a IP ${mqttHost} (bez flashe)…`);
        try {
          await sendCfg(false);
        } catch (provErr) {
          if (provErr.code === "NO_BANNER") {
            await flashFw("Na destičce není firmware, nahrávám…");
            this.setLog("Firmware nahraný. Posílám Wi-Fi a IP Klikače…");
            await sendCfg(false);
          } else if (provErr.code === "NVS_FAIL") {
            await flashFw("Paměť destičky odmítla zápis, nahrávám firmware a píšu síť přímo do flash…");
            await writeFlashOnly();
          } else {
            throw provErr;
          }
        }
      }
      return this.finishInit(port.path, mqttHost, wifiSsid);
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
      const beforeFw = this.mqtt.snapshot().fw || "";
      const { firmwareBin, version } = await this.resolveImages({ otaOnly: true });
      this.state.status = "uploading";
      this.setLog(`Wi-Fi OTA${version ? ` ${version}` : ""} na ${ip} přes HTTP ${OTA_HTTP_PORT}…`);
      try {
        await this.flashHttp(firmwareBin, { beforeFw });
        this.state.status = "ok";
        this.state.progress = 1;
        this.setLog("Firmware nahraný přes Wi-Fi. Destička je znovu na MQTT.");
        return this.snapshot();
      } catch (httpErr) {
        if (httpErr.code !== "NO_DOWNLOAD") {
          throw httpErr;
        }
        this.setLog(`${httpErr.message} Zkouším ArduinoOTA…`);
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
        this.setLog("ArduinoOTA hotové. Čekám až destička naskočí s novou verzí…");
        await this.waitForNewFw(beforeFw, 60000);
        this.state.status = "ok";
        this.state.progress = 1;
        this.setLog("Firmware nahraný přes Wi-Fi (ArduinoOTA).");
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

  async ensureEspflash() {
    let espflash = this.bundledFile("espflash.exe") || path.join(this.cacheDir(), "espflash.exe");
    if (fs.existsSync(espflash)) {
      return espflash;
    }
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
      return found;
    }
    await downloadFile(url, espflash);
    return espflash;
  }

  async waitForMqttJoin(seconds = 30) {
    this.setLog(`Nech COM zapojený. Čekám až ${seconds} s, až destička naskočí na MQTT…`);
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (this.mqtt && typeof this.mqtt.isLive === "function" && this.mqtt.isLive()) {
        const snap = this.mqtt.snapshot();
        this.setLog(`Destička je na MQTT${snap.ip ? ` (${snap.ip})` : ""}.`);
        return true;
      }
      const snap = this.mqtt ? this.mqtt.snapshot() : {};
      if (snap.status === "online" || snap.ip) {
        this.setLog(`Destička je na MQTT${snap.ip ? ` (${snap.ip})` : ""}.`);
        return true;
      }
      await sleep(400);
    }
    return false;
  }

  async runDiagnoseOn(portPath) {
    this.setLog(`Čtu destičku na ${portPath} (reset + log + KCFG STATUS)…`);
    const info = await diagnoseSerial({
      port: portPath,
      onLine: (line) => this.setLog(line),
    });
    const bits = [
      info.firmware ? `fw ${info.firmware}` : "",
      `wifi=${info.wifi || "(empty)"}`,
      `mqtt=${info.mqtt || "(empty)"}`,
      info.wifiSta ? `sta=${info.wifiSta}${info.wifiStaLabel ? ` ${info.wifiStaLabel}` : ""}` : "",
      info.wifiIp ? `ip=${info.wifiIp}` : "",
      info.mqttRc !== "" && info.mqttRc != null ? `mqtt-rc=${info.mqttRc}` : "",
    ].filter(Boolean);
    this.setLog(bits.join(" · "));
    this.setLog(info.hint);
    return info;
  }

  async finishInit(portPath, mqttHost, wifiSsid) {
    if (await this.waitForMqttJoin(30)) {
      this.state.status = "ok";
      this.state.progress = 1;
      this.setLog(`Hotovo. Destička je na MQTT. Odpoj COM a zapoj HID do herního PC. Broker ${mqttHost}:1883.`);
      return this.snapshot();
    }
    this.setLog("Destička na MQTT nedorazila. Čtu COM, COM neodpojuj…");
    const info = await this.runDiagnoseOn(portPath);
    throw new Error(
      info.hint
      || `Destička se po zápisu „${wifiSsid}“ / ${mqttHost} na MQTT nepřipojila. COM nech zapojený a zkus Číst destičku.`,
    );
  }

  async diagnose() {
    if (this.busy) {
      throw new Error("Nahrávání už běží");
    }
    this.busy = true;
    this.state.error = "";
    this.state.method = "com";
    this.state.status = "uploading";
    this.setLog("Připravuji čtení destičky přes COM…");
    try {
      const ports = await listSerialPorts();
      this.state.ports = ports;
      const port = pickFlashPort(ports);
      if (!port) {
        throw new Error("Flash kabel (CH343/COM) na tomhle PC není. Čtení destičky dělej na PC1 s programovacím USB.");
      }
      const info = await this.runDiagnoseOn(port.path);
      this.state.status = "ok";
      this.state.progress = 1;
      return { ...this.snapshot(), diagnosis: info };
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

  async writeCfgFlash({ port, wifiSsid, wifiPassword, mqttHost }) {
    const blob = buildCfgFlash({ wifiSsid, wifiPassword, mqttHost });
    const file = path.join(this.cacheDir(), "klikac-cfg.bin");
    fs.writeFileSync(file, blob);
    const parsed = require("./cfgFlashBlob").parseCfgFlash(blob);
    this.setLog(`Cfg blob wifi=„${parsed.wifiSsid}“ mqtt=${parsed.mqttHost} (${blob.length} B)`);
    const espflash = await this.ensureEspflash();
    for (const addr of CFG_FLASH_ADDRS) {
      const hex = `0x${addr.toString(16)}`;
      this.setLog(`Zapisuji Wi-Fi/MQTT do flash ${hex} (obejdu NVS)…`);
      await this.runProcess(espflash, [
        "write-bin",
        "--port",
        port,
        "--baud",
        "921600",
        "--flash-size",
        "16mb",
        hex,
        file,
      ]);
      this.setLog(`Flash cfg zapsaná ${hex}.`);
    }
  }

  async flashUsb({ port, image }) {
    const espflash = await this.ensureEspflash();
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

  async waitForNewFw(beforeFw, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = this.mqtt.snapshot();
      if (snap.otaStatus === "ok") {
        this.setLog("Destička potvrdila OTA.");
        return snap.fw || beforeFw || "ok";
      }
      if (snap.fw && beforeFw && snap.fw !== beforeFw) {
        this.setLog(`Destička hlásí firmware ${snap.fw}.`);
        return snap.fw;
      }
      if (snap.otaStatus && snap.otaStatus !== "start" && snap.otaStatus !== "ok") {
        throw new Error(`Destička OTA odmítla: ${snap.otaStatus}`);
      }
      await sleep(400);
    }
    throw new Error("Destička po OTA nehlásí novou verzi. Zkus znovu, nebo nahraj přes USB.");
  }

  async flashHttp(firmwareBin, { beforeFw = "" } = {}) {
    if (!this.mqtt.isReady()) {
      throw new Error("MQTT není připojený, destička si firmware nestáhne");
    }
    const ip = lanIPv4();
    if (!ip) {
      throw new Error("PC1 nemá LAN IP pro HTTP OTA");
    }
    if (typeof this.mqtt.clearOtaStatus === "function") {
      this.mqtt.clearOtaStatus();
    }
    const served = await this.serveFile(firmwareBin, ip, OTA_HTTP_PORT);
    this.mqtt.publish(otaTopic, served.url);
    this.setLog(`Odesláno destičce: ${served.url}`);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !served.downloaded()) {
      const snap = this.mqtt.snapshot();
      if (snap.otaStatus && snap.otaStatus !== "start" && snap.otaStatus !== "ok") {
        served.close();
        throw new Error(`Destička OTA odmítla: ${snap.otaStatus}`);
      }
      await sleep(400);
    }
    if (!served.downloaded()) {
      served.close();
      const err = new Error(`Destička si firmware nestáhla z ${served.url}. Povol na PC1 firewall TCP ${OTA_HTTP_PORT}.`);
      err.code = "NO_DOWNLOAD";
      throw err;
    }
    this.setLog("Destička stahuje firmware. Čekám na restart a novou verzi…");
    try {
      await this.waitForNewFw(beforeFw, 90000);
    } finally {
      served.close();
    }
  }

  serveFile(filePath, ip, port) {
    return new Promise((resolve, reject) => {
      let downloaded = false;
      let closed = false;
      const server = http.createServer(async (req, res) => {
        const url = String(req.url || "").split("?")[0];
        if (url !== "/firmware.bin") {
          res.statusCode = 404;
          res.end();
          return;
        }
        this.setLog("Destička si bere firmware.bin…");
        downloaded = true;
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(filePath).size);
        try {
          await pipeline(createReadStream(filePath), res);
          this.state.progress = 1;
          this.emit();
        } catch {
          /* client hangup */
        }
      });
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        server.close();
      };
      server.on("error", reject);
      server.listen(port, "0.0.0.0", () => {
        resolve({
          url: `http://${ip}:${port}/firmware.bin`,
          downloaded: () => downloaded,
          close,
        });
      });
    });
  }
}

module.exports = { FirmwareService };
