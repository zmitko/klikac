const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ovladac", {
  getState: () => ipcRenderer.invoke("get-state"),
  setState: (patch) => ipcRenderer.invoke("set-state", patch),
  command: (payload) => ipcRenderer.invoke("command", payload),
  mouseClick: (button) => ipcRenderer.invoke("mouse-click", button),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  flashFirmware: () => ipcRenderer.invoke("flash-firmware"),
  onState: (handler) => {
    ipcRenderer.on("state", (_event, snap) => handler(snap));
  },
});
