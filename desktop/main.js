const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { AppCore } = require("./lib/appCore");
const { AppUpdater } = require("./lib/appUpdater");
const { FirmwareService } = require("./lib/firmwareService");

let mainWindow = null;
let tray = null;
let quitting = false;
let core = null;
let updater = null;
let firmware = null;

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
    mqttHost: merged.mqttHost || "127.0.0.1",
    mqttPort: Number.parseInt(merged.mqttPort || 1883, 10),
    mqttUser: merged.mqttUser || "",
    mqttPassword: merged.mqttPassword || "",
    targetPcHost: merged.targetPcHost || "",
    targetPcName: merged.targetPcName || "PC",
    otaPassword: merged.otaPassword || "",
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
    height: 720,
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

function sendState() {
  if (!core || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const snap = core.snapshot();
  snap.update = updater ? updater.snapshot() : null;
  snap.firmware = firmware ? firmware.snapshot() : null;
  mainWindow.webContents.send("state", snap);
}

function bindIpc() {
  ipcMain.handle("get-state", () => {
    const snap = core.snapshot();
    snap.update = updater ? updater.snapshot() : null;
    snap.firmware = firmware ? firmware.snapshot() : null;
    return snap;
  });
  ipcMain.handle("set-state", (_event, patch) => {
    const snap = core.applyState(patch);
    snap.update = updater ? updater.snapshot() : null;
    snap.firmware = firmware ? firmware.snapshot() : null;
    return snap;
  });
  ipcMain.handle("command", (_event, payload) => {
    core.sendCommand(payload);
    const snap = core.snapshot();
    snap.update = updater ? updater.snapshot() : null;
    snap.firmware = firmware ? firmware.snapshot() : null;
    return snap;
  });
  ipcMain.handle("mouse-click", (_event, button) => {
    core.mouseClick(button);
    const snap = core.snapshot();
    snap.update = updater ? updater.snapshot() : null;
    snap.firmware = firmware ? firmware.snapshot() : null;
    return snap;
  });
  ipcMain.handle("check-update", async () => updater.check());
  ipcMain.handle("install-update", async () => updater.install());
  ipcMain.handle("flash-firmware", async () => firmware.flash());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.setName("Klikač");
  app.setAppUserModelId("cz.klikac.esp32");
  app.whenReady().then(() => {
    const cfg = loadConfig();
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
    });
    updater = new AppUpdater({ onChange: () => sendState() });
    firmware = new FirmwareService({
      mqtt: core.mqtt,
      otaPassword: cfg.otaPassword,
      onChange: () => sendState(),
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
});
