const test = require("node:test");
const assert = require("node:assert/strict");
const { validator, runtime, simpleParser, compiler } = require("../lib/macro");

// Virtuální hodiny: čekání se nečeká, jen se posune čas.
function runProgram(text, options) {
  const opts = options || {};
  const result = opts.ir ? { ok: true, ir: opts.ir } : validator.validateText(text);
  assert.equal(result.ok, true, `program není validní: ${JSON.stringify((result.errors || []).map((e) => e.message))}`);
  const trace = [];
  const start = opts.startClock || 1700000000000;
  let clock = start;
  const vm = runtime.createVm(result.ir, {
    press: (key) => {
      trace.push({ type: "press", key, at: clock - start });
    },
    log: (message) => {
      trace.push({ type: "log", message, at: clock - start });
    },
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    random: opts.random || (() => 0.5),
    pressGuardMs: opts.pressGuardMs == null ? 0 : opts.pressGuardMs,
    delayMin: opts.delayMin,
    delayMax: opts.delayMax,
  });
  return vm.run().then((outcome) => ({
    outcome,
    trace,
    keys: trace.filter((item) => item.type === "press").map((item) => item.key),
    logs: trace.filter((item) => item.type === "log").map((item) => item.message),
    elapsed: clock - start,
    vm,
  }));
}

test("runtime: pevný cyklus mačká a čeká", async () => {
  const run = await runProgram("OPAKUJ 3x\n    STISK F1\n    CEKEJ 2s\nKONEC");
  assert.deepEqual(run.keys, ["F1", "F1", "F1"]);
  assert.equal(run.elapsed, 6000);
  assert.equal(run.outcome.reason, "done");
});

test("runtime: vnořený cyklus proběhne 5×3", async () => {
  const run = await runProgram("OPAKUJ 5x\n    OPAKUJ 3x\n        STISK F1\n    KONEC\nKONEC");
  assert.equal(run.keys.length, 15);
});

test("runtime: podmínka a JINAK", async () => {
  const yes = await runProgram("NASTAV X = 7\nPOKUD X >= 5\n    STISK F1\nJINAK\n    STISK F2\nKONEC");
  assert.deepEqual(yes.keys, ["F1"]);
  const no = await runProgram("NASTAV X = 1\nPOKUD X >= 5\n    STISK F1\nJINAK\n    STISK F2\nKONEC");
  assert.deepEqual(no.keys, ["F2"]);
});

test("runtime: logické operátory", async () => {
  const run = await runProgram([
    "NASTAV X = 7",
    "POKUD X >= 5 A X < 10",
    "    STISK F1",
    "KONEC",
    "POKUD X = 1 NEBO X = 7",
    "    STISK F2",
    "KONEC",
    "POKUD NE X = 3",
    "    STISK F3",
    "KONEC",
  ].join("\n"));
  assert.deepEqual(run.keys, ["F1", "F2", "F3"]);
});

test("runtime: proměnné, ZVYS, SNIZ a BREAK", async () => {
  const run = await runProgram([
    "NASTAV POCET = 0",
    "DOKOLA",
    "    ZVYS POCET O 1",
    "    STISK F1",
    "    POKUD POCET >= 4",
    "        BREAK",
    "    KONEC",
    "KONEC",
    "SNIZ POCET O 1",
    "VYPIS POCET",
  ].join("\n"));
  assert.equal(run.keys.length, 4);
  assert.deepEqual(run.logs, ["3"]);
});

test("runtime: CONTINUE přeskočí zbytek průchodu", async () => {
  const run = await runProgram([
    "NASTAV I = 0",
    "OPAKUJ 4x",
    "    ZVYS I O 1",
    "    POKUD I = 2",
    "        CONTINUE",
    "    KONEC",
    "    STISK F1",
    "KONEC",
  ].join("\n"));
  assert.equal(run.keys.length, 3);
});

test("runtime: STOP ukončí celý program", async () => {
  const run = await runProgram([
    "DOKOLA",
    "    STISK F1",
    "    STOP",
    "KONEC",
  ].join("\n"));
  assert.deepEqual(run.keys, ["F1"]);
  assert.equal(run.outcome.reason, "stopped");
});

test("runtime: volání makra s parametrem", async () => {
  const run = await runProgram([
    "MAKRO M1(POCET)",
    "    OPAKUJ POCET x",
    "        STISK F2",
    "    KONEC",
    "KONEC",
    "SPUST M1(4)",
  ].join("\n"));
  assert.deepEqual(run.keys, ["F2", "F2", "F2", "F2"]);
});

test("runtime: makro může volat jiné makro", async () => {
  const run = await runProgram([
    "MAKRO M2",
    "    STISK F2",
    "KONEC",
    "MAKRO M1",
    "    STISK F1",
    "    SPUST M2",
    "KONEC",
    "SPUST M1",
  ].join("\n"));
  assert.deepEqual(run.keys, ["F1", "F2"]);
});

test("runtime: parametr je lokální, globální proměnná zůstane", async () => {
  const run = await runProgram([
    "MAKRO M1(X)",
    "    ZVYS X O 10",
    "    VYPIS X",
    "KONEC",
    "NASTAV X = 1",
    "SPUST M1(5)",
    "VYPIS X",
  ].join("\n"));
  assert.deepEqual(run.logs, ["15", "1"]);
});

test("runtime: hloubka volání je pojistka i za běhu", async () => {
  // IR se rekurzí obejde ručně, protože validátor by ji nepustil dál
  const ir = {
    version: "2.0",
    main: { name: "__main", params: [], code: [{ op: "CALL", name: "M1", args: [], line: 1 }] },
    procs: { M1: { name: "M1", params: [], code: [{ op: "CALL", name: "M1", args: [], line: 2 }] } },
    device: null,
  };
  const vm = runtime.createVm(ir, { press: () => {}, sleep: () => Promise.resolve() });
  await assert.rejects(() => vm.run(), /Příliš hluboké volání maker/);
});

test("runtime: náhodné čekání drží zadaný rozsah", async () => {
  const low = await runProgram("CEKEJ NAHODNE 2s-6s", { random: () => 0 });
  assert.equal(low.elapsed, 2000);
  const high = await runProgram("CEKEJ NAHODNE 2s-6s", { random: () => 0.999999 });
  assert.equal(high.elapsed, 6000);
});

test("runtime: NASTAV X = NAHODNE 1-100 spadne do rozsahu", async () => {
  for (const roll of [0, 0.25, 0.5, 0.999999]) {
    const run = await runProgram("NASTAV X = NAHODNE 1-100\nVYPIS X", { random: () => roll });
    const value = Number(run.logs[0]);
    assert.ok(value >= 1 && value <= 100, `${value} není v 1-100`);
  }
});

test("runtime: vážená náhoda respektuje procenta", async () => {
  const program = [
    "NAHODNE",
    "    70%:",
    "        STISK F2",
    "    20%:",
    "        STISK F3",
    "    10%:",
    "        STISK F4",
    "KONEC",
  ].join("\n");
  assert.deepEqual((await runProgram(program, { random: () => 0.1 })).keys, ["F2"]);
  assert.deepEqual((await runProgram(program, { random: () => 0.8 })).keys, ["F3"]);
  assert.deepEqual((await runProgram(program, { random: () => 0.95 })).keys, ["F4"]);
});

test("runtime: PO DOBU skončí po zadaném čase", async () => {
  const run = await runProgram("PO DOBU 10s\n    STISK F1\n    CEKEJ 3s\nKONEC");
  assert.equal(run.keys.length, 4);
  assert.equal(run.elapsed, 12000);
});

test("runtime: KAZDYCH drží periodu", async () => {
  const run = await runProgram([
    "NASTAV I = 0",
    "KAZDYCH 10s",
    "    ZVYS I O 1",
    "    STISK F1",
    "    CEKEJ 1s",
    "    POKUD I >= 3",
    "        BREAK",
    "    KONEC",
    "KONEC",
  ].join("\n"));
  assert.deepEqual(run.trace.filter((t) => t.type === "press").map((t) => t.at), [0, 10000, 20000]);
});

test("runtime: UPLYNULO měří od TED", async () => {
  const run = await runProgram([
    "NASTAV START = TED",
    "CEKEJ 30s",
    "POKUD UPLYNULO START >= 30s",
    "    STISK F1",
    "KONEC",
  ].join("\n"));
  assert.deepEqual(run.keys, ["F1"]);
});

test("runtime: CEKEJ DO počká na daný čas i přes půlnoc", async () => {
  const morning = new Date(2026, 0, 5, 8, 0, 0, 0).getTime();
  const run = await runProgram("CEKEJ DO 18:00\nSTISK F1", { startClock: morning });
  assert.equal(run.elapsed, 10 * 3600000);

  const evening = new Date(2026, 0, 5, 19, 0, 0, 0).getTime();
  const next = await runProgram("CEKEJ DO 18:00\nSTISK F1", { startClock: evening });
  assert.equal(next.elapsed, 23 * 3600000);
});

test("runtime: simple makro jede na stejném enginu", async () => {
  const { ast: program } = simpleParser.parseSimple("F1,D3,F2,D5");
  const { ir } = compiler.compile(program);
  const trace = [];
  let clock = 0;
  let loops = 0;
  const vm = runtime.createVm(ir, {
    press: (key) => trace.push(key),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      loops += 1;
      if (loops > 20) {
        vm.stop();
      }
      return Promise.resolve();
    },
    random: () => 0.5,
    delayMin: 200,
    delayMax: 800,
    pressGuardMs: 0,
  });
  const outcome = await vm.run();
  assert.equal(outcome.reason, "stopped");
  assert.deepEqual(trace.slice(0, 4), ["F1", "F2", "F1", "F2"]);
});

test("runtime: stop() zastaví běžící nekonečné makro", async () => {
  const result = validator.validateText("DOKOLA\n    STISK F1\n    CEKEJ 1s\nKONEC");
  let clock = 0;
  let presses = 0;
  const vm = runtime.createVm(result.ir, {
    press: () => {
      presses += 1;
      if (presses === 5) {
        vm.stop();
      }
    },
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    pressGuardMs: 0,
  });
  const outcome = await vm.run();
  assert.equal(outcome.reason, "stopped");
  assert.equal(presses, 5);
});

test("runtime: cyklus bez stisku a čekání se ubrání zatuhnutí", async () => {
  const result = validator.validateText("NASTAV X = 0\nDOKOLA\n    ZVYS X O 1\nKONEC");
  const vm = runtime.createVm(result.ir, {
    press: () => {},
    sleep: () => Promise.resolve(),
    idleStepLimit: 5000,
  });
  await assert.rejects(() => vm.run(), /naprázdno/);
});
