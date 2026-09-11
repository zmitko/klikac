const { StateStore } = require("./stateStore");
const { MqttBridge } = require("./mqttBridge");
const { MouseBridge } = require("./mouseBridge");
const { PcPing } = require("./pcPing");

const COMMANDS = new Set([
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8",
  "ENTER", "LC", "RC", "LMB", "RMB",
]);

class AppCore {
  constructor({ statePath, mqtt, targetPc, onChange, onLog }) {
    this.onChange = onChange;
    this.store = new StateStore(statePath);
    this.mqtt = new MqttBridge(mqtt, () => this.emit(), onLog);
    this.pcPing = new PcPing(targetPc.host || "", targetPc.name || "PC");
    this.mouse = new MouseBridge({
      onClick: (payload) => {
        try {
          this.mqtt.publishCommand(payload);
        } catch {
          /* destička zrovna neposlouchá */
        }
        this.emit();
      },
    });
  }

  start() {
    this.mqtt.start();
    this.pcPing.start(() => this.emit());
    this.mouse.setEnabled(!!this.store.get().mouseBridge);
    this.emit();
  }

  shutdown() {
    this.mouse.setEnabled(false);
  }

  snapshot() {
    return {
      type: "state",
      ui: this.store.get(),
      device: this.mqtt.snapshot(),
      pc: this.pcPing.snapshot(),
      mouse: this.mouse.status(),
    };
  }

  emit() {
    if (typeof this.onChange === "function") {
      this.onChange(this.snapshot());
    }
  }

  sendCommand(raw) {
    const payload = String(raw || "").trim().toUpperCase();
    if (!COMMANDS.has(payload)) {
      const err = new Error("Neznámý příkaz");
      err.code = "BAD_COMMAND";
      throw err;
    }
    const mapped = payload === "LMB" ? "LC" : payload === "RMB" ? "RC" : payload;
    this.mqtt.publishCommand(mapped);
    this.emit();
    return mapped;
  }

  startMacro() {
    const payload = this.store.buildMacroPayload();
    if (!payload) {
      const err = new Error("Žádná aktivní sekvence k odeslání");
      err.code = "EMPTY_MACRO";
      throw err;
    }
    this.mqtt.publishMacro(payload);
    this.store.update({ macroRunning: true });
    this.emit();
    return payload;
  }

  stopMacro() {
    if (this.mqtt.isReady()) {
      this.mqtt.publishMacro("STOP");
    }
    this.store.update({ macroRunning: false });
    this.emit();
  }

  applyState(patch) {
    const prev = this.store.get();
    const next = this.store.update(patch || {});
    try {
      if (prev.macroRunning && !next.macroRunning) {
        this.stopMacro();
      } else if (!prev.macroRunning && next.macroRunning) {
        this.startMacro();
      }
      if (Object.prototype.hasOwnProperty.call(patch || {}, "mouseBridge")) {
        this.mouse.setEnabled(!!next.mouseBridge);
        this.store.update({ mouseBridge: this.mouse.status().enabled });
      }
      this.emit();
      return this.snapshot();
    } catch (err) {
      this.store.update({ macroRunning: false });
      this.emit();
      throw err;
    }
  }

  async healthCheck() {
    await this.mqtt.ping();
    this.emit();
    return this.snapshot();
  }

  mouseClick(button) {
    const result = this.mouse.handlePageClick(button);
    if (!result.ok) {
      const err = new Error("Přenos myši je vypnutý");
      err.code = result.reason;
      throw err;
    }
    this.emit();
    return result;
  }
}

module.exports = { AppCore };
