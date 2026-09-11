const { StateStore } = require("./stateStore");
const { MqttBridge } = require("./mqttBridge");
const { MouseBridge } = require("./mouseBridge");
const { PcPing } = require("./pcPing");
const { MacroRunner } = require("./macroRunner");
const { validator, MACRO_TYPE, LANG_VERSION } = require("./macro");

const COMMANDS = new Set([
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "ENTER", "LC", "RC", "LMB", "RMB",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "+", "ě", "Ě", "š", "Š", "č", "Č", "ř", "Ř", "ž", "Ž", "ý", "Ý", "á", "Á", "í", "Í", "é", "É",
]);

class AppCore {
  constructor({ statePath, mqtt, targetPc, onChange, onLog }) {
    this.onChange = onChange;
    this.onLog = onLog;
    this.store = new StateStore(statePath);
    this.mqtt = new MqttBridge(mqtt, () => this.emit(), onLog);
    this.pcPing = new PcPing(targetPc.host || "", targetPc.name || "PC");
    this.macroRunner = new MacroRunner({
      press: (key) => this.mqtt.publishCommand(key),
      onLog,
      onChange: () => this.emit(),
      onIdle: () => {
        if (this.store.get().macroRunning && !this.store.simpleSlots().length) {
          this.store.update({ macroRunning: false });
          this.emit();
        }
      },
    });
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
    const ui = this.store.get();
    this.mouse.setButtons({ lmb: ui.mouseLmb, rmb: ui.mouseRmb });
  }

  start() {
    this.mqtt.start();
    this.pcPing.start(() => this.emit());
    this.mouse.setEnabled(!!this.store.get().mouseBridge);
    this.emit();
  }

  shutdown() {
    this.mouse.setEnabled(false);
    this.macroRunner.stop();
  }

  snapshot() {
    return {
      type: "state",
      ui: this.store.get(),
      device: this.mqtt.snapshot(),
      pc: this.pcPing.snapshot(),
      mouse: this.mouse.status(),
      macro: { ...this.macroRunner.snapshot(), lang: LANG_VERSION },
    };
  }

  emit() {
    if (typeof this.onChange === "function") {
      this.onChange(this.snapshot());
    }
  }

  sendCommand(raw) {
    let payload = String(raw || "").trim();
    if (/^f\d{1,2}$/i.test(payload) || /^(enter|lc|rc|lmb|rmb)$/i.test(payload)) {
      payload = payload.toUpperCase();
    }
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

  // Simple makra jedou dál na destičce, komplexní v aplikaci nad IR.
  // Oba vstupy prochází stejnou validací, jen mají jiný backend.
  startMacro() {
    const ui = this.store.get();
    const simple = this.store.simpleSlots();
    const complex = this.store.complexSlots();
    if (!simple.length && !complex.length) {
      const err = new Error("Žádná aktivní sekvence k odeslání");
      err.code = "EMPTY_MACRO";
      throw err;
    }
    if (complex.length) {
      const check = this.macroRunner.validate(complex);
      if (!check.ok) {
        const first = check.problems[0];
        const label = first.name ? `${first.index + 1} (${first.name})` : String(first.index + 1);
        const detail = first.errors[0];
        const err = new Error(`Makro ${label}: ${detail.message}${detail.line ? ` (řádek ${detail.line})` : ""}`);
        err.code = "MACRO_INVALID";
        err.problems = check.problems;
        throw err;
      }
      if (!this.mqtt.isReady()) {
        const err = new Error("MQTT není připojený");
        err.code = "MQTT_OFF";
        throw err;
      }
    }
    const payload = this.store.buildMacroPayload();
    if (payload) {
      this.mqtt.publishMacro(payload);
    }
    if (complex.length) {
      this.macroRunner.start(complex, {
        loop: !!ui.macroLoop,
        delayMin: ui.delayMin,
        delayMax: ui.delayMax,
      });
    }
    this.store.update({ macroRunning: true });
    this.emit();
    return payload;
  }

  stopMacro() {
    this.macroRunner.stop();
    if (this.mqtt.isReady()) {
      this.mqtt.publishMacro("STOP");
    }
    this.store.update({ macroRunning: false });
    this.emit();
  }

  validateMacro(slot) {
    const result = validator.validateSlot(
      {
        type: slot && slot.type === MACRO_TYPE.COMPLEX ? MACRO_TYPE.COMPLEX : MACRO_TYPE.SIMPLE,
        seq: slot ? slot.seq : "",
        program: slot ? slot.program : "",
      },
      { loop: !!this.store.get().macroLoop },
    );
    return {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      levels: result.levels,
      device: result.device,
    };
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
      if (Object.prototype.hasOwnProperty.call(patch || {}, "mouseLmb")
        || Object.prototype.hasOwnProperty.call(patch || {}, "mouseRmb")) {
        this.mouse.setButtons({ lmb: next.mouseLmb, rmb: next.mouseRmb });
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
