// Zpětná kompatibilita stavu: staré state.json bez typu makra musí fungovat dál.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StateStore, STATE_SCHEMA_VERSION } = require("../lib/stateStore");

function withStore(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klikac-test-"));
  const file = path.join(dir, "state.json");
  if (initial !== undefined) {
    fs.writeFileSync(file, JSON.stringify(initial), "utf8");
  }
  try {
    fn(new StateStore(file), file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("stav: starý soubor bez typu se načte jako SIMPLE", () => {
  withStore(
    {
      macroLoop: true,
      delayMin: 300,
      delayMax: 900,
      slots: [
        { name: "AFK", seq: "F1,D2,F2,D", enabled: true },
        { name: "", seq: "", enabled: false },
      ],
    },
    (store) => {
      const state = store.get();
      assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
      assert.equal(state.slots[0].type, "SIMPLE");
      assert.equal(state.slots[0].program, "");
      assert.equal(state.slots[0].seq, "F1,D2,F2,D");
      assert.equal(state.slots.length, 5);
    },
  );
});

test("stav: ještě starší formát s macroActive dál určuje aktivní sloty", () => {
  withStore({ macroActive: "1,3", slots: [{ seq: "F1" }, { seq: "F2" }, { seq: "F3" }] }, (store) => {
    const state = store.get();
    assert.deepEqual(state.slots.map((slot) => slot.enabled), [true, false, true, false, false]);
    assert.deepEqual(state.slots.map((slot) => slot.type), Array(5).fill("SIMPLE"));
  });
});

test("stav: payload pro destičku je stejný jako v 1.0.x", () => {
  withStore(
    {
      macroLoop: true,
      delayMin: 200,
      delayMax: 800,
      slots: [
        { name: "A", seq: "F1,D2,F2,D", enabled: true },
        { name: "B", seq: "F3,D,F7,D900", enabled: true },
        { name: "C", seq: "F4", enabled: false },
      ],
    },
    (store) => {
      assert.equal(store.buildMacroPayload(), "1|200|800|F1,D2,F2,D;;1|200|800|F3,D,F7,D900");
    },
  );
});

test("stav: komplexní makro se do payloadu destičky neposílá", () => {
  withStore(
    {
      macroLoop: false,
      delayMin: 100,
      delayMax: 400,
      slots: [
        { name: "simple", seq: "F1,D2", enabled: true, type: "SIMPLE" },
        { name: "complex", seq: "F9,D9", enabled: true, type: "COMPLEX", program: "DOKOLA\n STISK F1\nKONEC" },
      ],
    },
    (store) => {
      assert.equal(store.buildMacroPayload(), "0|100|400|F1,D2");
      assert.deepEqual(store.simpleSlots().map((slot) => slot.index), [0]);
      assert.deepEqual(store.complexSlots().map((slot) => slot.index), [1]);
    },
  );
});

test("stav: komplexní slot bez programu se nepovažuje za aktivní", () => {
  withStore(
    { slots: [{ name: "x", seq: "F1", enabled: true, type: "COMPLEX", program: "   " }] },
    (store) => {
      assert.deepEqual(store.activeSlots(), []);
      assert.equal(store.buildMacroPayload(), "");
    },
  );
});

test("stav: typ a program přežijí uložení a načtení", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klikac-test-"));
  const file = path.join(dir, "state.json");
  try {
    const first = new StateStore(file);
    first.update({
      slots: [
        { name: "V2", seq: "", enabled: true, type: "COMPLEX", program: "OPAKUJ 3x\n    STISK F1\nKONEC" },
        { name: "", seq: "", enabled: false },
        { name: "", seq: "", enabled: false },
        { name: "", seq: "", enabled: false },
        { name: "", seq: "", enabled: false },
      ],
    });
    const second = new StateStore(file);
    const slot = second.get().slots[0];
    assert.equal(slot.type, "COMPLEX");
    assert.equal(slot.program, "OPAKUJ 3x\n    STISK F1\nKONEC");
    assert.equal(second.get().schemaVersion, STATE_SCHEMA_VERSION);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stav: neznámý typ spadne zpátky na SIMPLE", () => {
  withStore({ slots: [{ seq: "F1", enabled: true, type: "SUPER" }] }, (store) => {
    assert.equal(store.get().slots[0].type, "SIMPLE");
  });
});
