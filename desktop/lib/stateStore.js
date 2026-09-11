const fs = require("fs");
const path = require("path");

const DEFAULT_STATE = {
  controllerEnabled: true,
  macroActive: "1,2,3",
  macroLoop: true,
  delayMin: 200,
  delayMax: 800,
  macroRunning: false,
  mouseBridge: false,
  wifiSsid: "",
  wifiPassword: "",
  mqttHost: "",
  slots: [
    { name: "AFK ASSIST", seq: "F1,D2,F2,D,F5,D", enabled: true },
    { name: "REBUFF", seq: "F3,D,F7,D900", enabled: true },
    { name: "BODY TO MIND", seq: "F4,D,F5,D60", enabled: true },
    { name: "", seq: "", enabled: false },
    { name: "", seq: "", enabled: false },
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
      seq: src && typeof src.seq === "string" ? src.seq.slice(0, 384) : "",
      enabled,
    });
  }
  return out;
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
    next.controllerEnabled = !!next.controllerEnabled;
    next.macroLoop = !!next.macroLoop;
    next.macroRunning = !!next.macroRunning;
    next.mouseBridge = !!next.mouseBridge;
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

  buildMacroPayload() {
    const loopFlag = this.state.macroLoop ? "1" : "0";
    const dmin = this.state.delayMin;
    const dmax = this.state.delayMax;
    const lines = [];
    for (const slot of this.state.slots) {
      if (!slot.enabled) {
        continue;
      }
      const seq = slot.seq ? slot.seq.trim() : "";
      if (!seq) {
        continue;
      }
      lines.push(`${loopFlag}|${dmin}|${dmax}|${seq}`);
    }
    return lines.join(";;");
  }
}

module.exports = { StateStore, DEFAULT_STATE };
