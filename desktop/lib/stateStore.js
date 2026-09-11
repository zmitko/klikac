const fs = require("fs");
const path = require("path");
const { MACRO_TYPE } = require("./macro/ast");

// 1 = stav bez typu makra (Klikač 1.0.x), 2 = SIMPLE / COMPLEX (1.1.x)
const STATE_SCHEMA_VERSION = 2;
const PROGRAM_MAX = 8000;

const DEFAULT_STATE = {
  schemaVersion: STATE_SCHEMA_VERSION,
  controllerEnabled: true,
  macroActive: "1,2,3",
  macroLoop: true,
  delayMin: 200,
  delayMax: 800,
  macroRunning: false,
  mouseBridge: false,
  mouseLmb: true,
  mouseRmb: true,
  wifiSsid: "",
  wifiPassword: "",
  mqttHost: "",
  slots: [
    { name: "AFK ASSIST", seq: "F1,D2,F2,D,F5,D", enabled: true, type: MACRO_TYPE.SIMPLE, program: "" },
    { name: "REBUFF", seq: "F3,D,F7,D900", enabled: true, type: MACRO_TYPE.SIMPLE, program: "" },
    { name: "BODY TO MIND", seq: "F4,D,F5,D60", enabled: true, type: MACRO_TYPE.SIMPLE, program: "" },
    { name: "", seq: "", enabled: false, type: MACRO_TYPE.SIMPLE, program: "" },
    { name: "", seq: "", enabled: false, type: MACRO_TYPE.SIMPLE, program: "" },
  ],
};

function clampDelay(n, fallback) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v)) {
    return fallback;
  }
  return Math.min(5000, Math.max(1, v));
}

function activeIndexSet(macroActive) {
  const set = new Set();
  String(macroActive || "").split(",").forEach((part) => {
    if (["1", "2", "3", "4", "5"].includes(part)) {
      set.add(Number(part) - 1);
    }
  });
  return set;
}

// Starší makro typ nemá — bere se jako SIMPLE, aby se nic nerozbilo.
function normalizeType(value) {
  return String(value || "").toUpperCase() === MACRO_TYPE.COMPLEX ? MACRO_TYPE.COMPLEX : MACRO_TYPE.SIMPLE;
}

function normalizeSlots(slots, macroActive) {
  const hasEnabled = Array.isArray(slots) && slots.some((s) => s && typeof s.enabled === "boolean");
  const legacy = hasEnabled ? null : activeIndexSet(macroActive == null ? "1,2,3" : macroActive);
  const out = [];
  for (let i = 0; i < 5; i++) {
    const src = Array.isArray(slots) ? slots[i] : null;
    let enabled = false;
    if (src && typeof src.enabled === "boolean") {
      enabled = src.enabled;
    } else if (legacy) {
      enabled = legacy.has(i);
    }
    out.push({
      name: src && typeof src.name === "string" ? src.name.slice(0, 40) : "",
      seq: src && typeof src.seq === "string" ? src.seq.slice(0, 768) : "",
      enabled,
      type: normalizeType(src && src.type),
      program: src && typeof src.program === "string" ? src.program.slice(0, PROGRAM_MAX) : "",
    });
  }
  return out;
}

function slotHasContent(slot) {
  if (!slot || !slot.enabled) {
    return false;
  }
  return slot.type === MACRO_TYPE.COMPLEX
    ? !!String(slot.program || "").trim()
    : !!String(slot.seq || "").trim();
}

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { ...DEFAULT_STATE, slots: normalizeSlots(DEFAULT_STATE.slots) };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = this.merge(parsed);
    } catch {
      this.state = this.merge({});
      this.save();
    }
  }

  merge(partial) {
    const next = { ...this.state, ...partial };
    next.schemaVersion = STATE_SCHEMA_VERSION;
    next.controllerEnabled = !!next.controllerEnabled;
    next.macroLoop = !!next.macroLoop;
    next.macroRunning = !!next.macroRunning;
    next.mouseBridge = !!next.mouseBridge;
    next.mouseLmb = next.mouseLmb !== false;
    next.mouseRmb = next.mouseRmb !== false;
    next.wifiSsid = String(next.wifiSsid || "").slice(0, 32);
    next.wifiPassword = String(next.wifiPassword || "").slice(0, 64);
    next.mqttHost = String(next.mqttHost || "").trim().slice(0, 45);
    next.delayMin = clampDelay(next.delayMin, 200);
    next.delayMax = clampDelay(next.delayMax, 800);
    if (next.delayMax < next.delayMin) {
      const tmp = next.delayMin;
      next.delayMin = next.delayMax;
      next.delayMax = tmp;
    }
    next.slots = normalizeSlots(next.slots, next.macroActive);
    next.macroActive = next.slots
      .map((slot, i) => (slot.enabled ? String(i + 1) : ""))
      .filter(Boolean)
      .join(",");
    return next;
  }

  get() {
    return JSON.parse(JSON.stringify(this.state));
  }

  update(partial) {
    this.state = this.merge(partial);
    this.save();
    return this.get();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  // Payload pro destičku — jen Simple makra, formát zůstává „loop|dmin|dmax|seq;;…“.
  buildMacroPayload(sequences) {
    const loopFlag = this.state.macroLoop ? "1" : "0";
    const dmin = this.state.delayMin;
    const dmax = this.state.delayMax;
    const lines = [];
    if (Array.isArray(sequences)) {
      sequences.forEach((seq) => {
        const text = String(seq || "").trim();
        if (text) {
          lines.push(`${loopFlag}|${dmin}|${dmax}|${text}`);
        }
      });
      return lines.join(";;");
    }
    for (const slot of this.state.slots) {
      if (!slotHasContent(slot) || slot.type === MACRO_TYPE.COMPLEX) {
        continue;
      }
      lines.push(`${loopFlag}|${dmin}|${dmax}|${slot.seq.trim()}`);
    }
    return lines.join(";;");
  }

  activeSlots() {
    return this.state.slots
      .map((slot, index) => ({ ...slot, index }))
      .filter((slot) => slotHasContent(slot));
  }

  simpleSlots() {
    return this.activeSlots().filter((slot) => slot.type !== MACRO_TYPE.COMPLEX);
  }

  complexSlots() {
    return this.activeSlots().filter((slot) => slot.type === MACRO_TYPE.COMPLEX);
  }
}

module.exports = { StateStore, DEFAULT_STATE, STATE_SCHEMA_VERSION, slotHasContent };
