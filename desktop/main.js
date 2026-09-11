const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");
const { AppCore } = require("./lib/appCore");
const { AppUpdater } = require("./lib/appUpdater");
const { FirmwareService } = require("./lib/firmwareService");
const { MqttBroker } = require("./lib/mqttBroker");
const { AppLog } = require("./lib/appLog");
const { MQTT_PORT, MQTT_USER, MQTT_PASSWORD, OTA_PASSWORD } = require("./lib/mqttCreds");
const { lanIPv4 } = require("./lib/lan");

let mainWindow = null;
let tray = null;
let quitting = false;
let core = null;
let updater = null;
let firmware = null;
let broker = null;
let appLog = null;

function iconPath(name) {
  const ico = path.join(__dirname, "assets", "icon.ico");
  const png = path.join(__dirname, "assets", "icon.png");
  if (name === "ico" && fs.existsSync(ico)) {
    return ico;
  }
  return fs.existsSync(png) ? png : ico;
}

function loadConfig() {
  const userFile = path.join(app.getPath("userData"), "config.json");
  const localFile = path.join(__dirname, "config.json");
  const exampleFile = path.join(__dirname, "config.example.json");
  const source = [userFile, localFile, exampleFile].find((p) => fs.existsSync(p));
  const raw = source ? JSON.parse(fs.readFileSync(source, "utf8")) : {};
  const fallback = localFile !== source && fs.existsSync(localFile)
    ? JSON.parse(fs.readFileSync(localFile, "utf8"))
    : {};
  const merged = { ...fallback, ...raw };
  if (!merged.otaPassword && fallback.otaPassword) {
    merged.otaPassword = fallback.otaPassword;
  }
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  if (!fs.existsSync(userFile) && source && source !== userFile) {
    fs.writeFileSync(userFile, JSON.stringify(merged, null, 2), "utf8");
  }
  return {
    mqttHost: "127.0.0.1",
    mqttPort: MQTT_PORT,
    mqttUser: MQTT_USER,
    mqttPassword: MQTT_PASSWORD,
    targetPcHost: merged.targetPcHost || "",
    targetPcName: merged.targetPcName || "PC",
    otaPassword: OTA_PASSWORD,
  };
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.webContents.reloadIgnoringCache();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const icon = nativeImage.createFromPath(iconPath("ico"));
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 920,
    minHeight: 620,
    title: "Klikač",
    backgroundColor: "#f6f7f9",
    icon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  let image = nativeImage.createFromPath(iconPath("png"));
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(iconPath("ico"));
  }
  if (!image.isEmpty()) {
    image = image.resize({ width: 32, height: 32, quality: "best" });
  }
  tray = new Tray(image);
  tray.setToolTip("Klikač");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Settings",
      click: () => showMainWindow(),
    },
    { type: "separator" },
    {
      label: "Exit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
  tray.on("click", () => showMainWindow());
}

function attachSnap(snap) {
  snap.update = updater ? updater.snapshot() : null;
  snap.firmware = firmware ? firmware.snapshot() : null;
  snap.net = broker ? broker.snapshot() : { lanIp: lanIPv4(), port: MQTT_PORT };
  snap.log = appLog ? appLog.snapshot() : [];
  if (snap.device && broker) {
    snap.device.present = broker.hasDevice();
    if (snap.device.present) {
      snap.device.live = true;
      if (snap.device.status !== "online") {
        snap.device.status = "online";
      }
    } else if (!snap.device.live) {
      snap.device.status = "offline";
    }
  }
  return snap;
}

function sendState() {
  if (!core || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("state", attachSnap(core.snapshot()));
}

function bindIpc() {
  ipcMain.handle("get-state", () => attachSnap(core.snapshot()));
  ipcMain.handle("set-state", (_event, patch) => attachSnap(core.applyState(patch)));
  ipcMain.handle("command", (_event, payload) => {
    core.sendCommand(payload);
    return attachSnap(core.snapshot());
  });
  ipcMain.handle("mouse-click", (_event, button) => {
    core.mouseClick(button);
    return attachSnap(core.snapshot());
  });
  ipcMain.handle("validate-macro", (_event, slot) => core.validateMacro(slot));
  ipcMain.handle("check-update", async () => updater.check());
  ipcMain.handle("install-update", async () => updater.install());
  ipcMain.handle("flash-firmware", async () => {
    const ui = core.store.get();
    return firmware.flash({
      wifiSsid: ui.wifiSsid,
      wifiPassword: ui.wifiPassword,
      mqttHost: String(ui.mqttHost || "").trim() || lanIPv4(),
    });
  });
  ipcMain.handle("ota-firmware", async () => firmware.ota());
  ipcMain.handle("clear-log", () => {
    if (appLog) {
      appLog.clear();
    }
    return attachSnap(core.snapshot());
  });
  ipcMain.handle("copy-text", (_event, text) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });
  ipcMain.handle("health-check", async () => {
    if (broker) {
      broker.refreshLan();
    }
    const snap = attachSnap(await core.healthCheck());
    if (snap.device && broker && broker.hasDevice()) {
      snap.device.live = true;
      snap.device.present = true;
      if (snap.device.health === "timeout") {
        snap.device.health = "ok";
        if (appLog) {
          appLog.push("app", "healthcheck: destička je na brokeru");
        }
      }
    }
    return snap;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.setName("Klikač");
  app.setAppUserModelId("cz.klikac.esp32");
  app.whenReady().then(async () => {
    const cfg = loadConfig();
    appLog = new AppLog({ onChange: () => sendState() });
    broker = new MqttBroker({
      onLog: (src, msg) => appLog.push(src, msg),
      onChange: () => sendState(),
    });
    try {
      await broker.start();
    } catch (err) {
      appLog.push("mqtt", `broker start fail: ${err.message}`);
    }
    appLog.push("app", `Klikač ${app.getVersion()}`);
    core = new AppCore({
      statePath: path.join(app.getPath("userData"), "state.json"),
      mqtt: {
        host: cfg.mqttHost,
        port: cfg.mqttPort,
        user: cfg.mqttUser,
        password: cfg.mqttPassword,
      },
      targetPc: {
        host: cfg.targetPcHost,
        name: cfg.targetPcName,
      },
      onChange: () => sendState(),
      onLog: (src, msg) => appLog.push(src, msg),
    });
    updater = new AppUpdater({ onChange: () => sendState() });
    firmware = new FirmwareService({
      mqtt: core.mqtt,
      otaPassword: cfg.otaPassword,
      onChange: () => sendState(),
      onLog: (src, msg) => appLog.push(src, msg),
    });
    core.start();
    updater.start();
    firmware.check().catch(() => {});
    bindIpc();
    createTray();
    createWindow();
  });
}

app.on("window-all-closed", () => {
  // Tray app stays running.
});

app.on("before-quit", () => {
  quitting = true;
  if (core) {
    core.shutdown();
  }
  if (broker) {
    broker.stop().catch(() => {});
  }
});
