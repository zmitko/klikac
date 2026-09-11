// MacroRunner je napojení compileru na existující runner (MQTT příkazy).
const test = require("node:test");
const assert = require("node:assert/strict");
const { MacroRunner } = require("../lib/macroRunner");

function makeRunner() {
  const pressed = [];
  const logs = [];
  const runner = new MacroRunner({
    press: (key) => pressed.push(key),
    onLog: (source, message) => logs.push(`${source}: ${message}`),
    onChange: () => {},
    onIdle: () => logs.push("idle"),
  });
  return { runner, pressed, logs };
}

function waitFor(check, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timeout"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("runner: komplexní makro mačká přes předaný kanál", async () => {
  const { runner, pressed, logs } = makeRunner();
  const started = runner.start(
    [{ index: 2, name: "V2", type: "COMPLEX", program: "OPAKUJ 2x\n    STISK F1\nKONEC" }],
    { loop: false, delayMin: 200, delayMax: 800 },
  );
  assert.equal(started, 1);
  assert.equal(runner.isRunning(), true);
  await waitFor(() => !runner.isRunning());
  assert.deepEqual(pressed, ["F1", "F1"]);
  assert.ok(logs.some((line) => line.includes("3 (V2): start")));
  assert.ok(logs.includes("idle"));
});

test("runner: nevalidní makro se nespustí a řekne proč", () => {
  const { runner, pressed } = makeRunner();
  assert.throws(
    () => runner.start([{ index: 0, name: "rozbité", type: "COMPLEX", program: "OPAKUJ 5x\n    STISK F1" }], {}),
    (err) => {
      assert.equal(err.code, "MACRO_INVALID");
      assert.match(err.message, /Chybí KONEC/);
      return true;
    },
  );
  assert.equal(runner.isRunning(), false);
  assert.deepEqual(pressed, []);
});

test("runner: stop zastaví nekonečné makro", async () => {
  const { runner, pressed } = makeRunner();
  runner.start(
    [{ index: 0, name: "", type: "COMPLEX", program: "DOKOLA\n    STISK F1\n    CEKEJ 50ms\nKONEC" }],
    { loop: true },
  );
  await waitFor(() => pressed.length >= 2);
  runner.stop();
  const seen = pressed.length;
  assert.equal(runner.isRunning(), false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(pressed.length, seen, "po stopu už nic nemačká");
});

test("runner: VYPIS jde do protokolu", async () => {
  const { runner, logs } = makeRunner();
  runner.start(
    [{ index: 1, name: "log", type: "COMPLEX", program: "NASTAV X = 4\nVYPIS X\nVYPIS \"hotovo\"" }],
    { loop: false },
  );
  await waitFor(() => !runner.isRunning());
  assert.ok(logs.some((line) => line.includes("2 (log): 4")));
  assert.ok(logs.some((line) => line.includes("2 (log): hotovo")));
});

test("runner: varování se vypíše, ale makro poběží", async () => {
  const { runner, logs } = makeRunner();
  runner.start(
    [{ index: 0, name: "", type: "COMPLEX", program: "NASTAV NEPOUZITA = 1\nSTISK F1" }],
    { loop: false },
  );
  await waitFor(() => !runner.isRunning());
  assert.ok(logs.some((line) => line.includes("⚠") && line.includes("NEPOUZITA")));
});

test("runner: chyba při mačkání makro ukončí a zaloguje", async () => {
  const logs = [];
  const runner = new MacroRunner({
    press: () => {
      throw new Error("MQTT není připojený");
    },
    onLog: (_source, message) => logs.push(message),
    onChange: () => {},
  });
  runner.start([{ index: 0, name: "", type: "COMPLEX", program: "STISK F1" }], { loop: false });
  await waitFor(() => !runner.isRunning());
  assert.ok(logs.some((line) => line.includes("chyba — MQTT není připojený")));
});

test("runner: simple sloty runner ignoruje, ty jedou na destičce", () => {
  const { runner } = makeRunner();
  const started = runner.start([{ index: 0, name: "", type: "SIMPLE", seq: "F1,D2" }], { loop: true });
  assert.equal(started, 0);
  assert.equal(runner.isRunning(), false);
});
