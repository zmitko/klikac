const test = require("node:test");
const assert = require("node:assert/strict");
const { simpleParser, validator, compiler } = require("../lib/macro");

test("simple: F1,D3,F2,D5 dá dokola běžící program", () => {
  const { ast: program, errors } = simpleParser.parseSimple("F1,D3,F2,D5");
  assert.deepEqual(errors, []);
  assert.equal(program.body.length, 1);
  const cycle = program.body[0];
  assert.equal(cycle.kind, "Forever");
  assert.deepEqual(
    cycle.body.map((node) => `${node.kind}:${node.key || node.seconds}`),
    ["Press:F1", "Wait:3", "Press:F2", "Wait:5"],
  );
});

test("simple: holé D je prodleva z posuvníků, Dn je N sekund + prodleva", () => {
  const { ast: program } = simpleParser.parseSimple("F1,D,F2,D900");
  const [press1, delay1, press2, delay2] = program.body[0].body;
  assert.equal(press1.key, "F1");
  assert.equal(delay1.mode, "delay");
  assert.equal(delay1.seconds, 0);
  assert.equal(press2.key, "F2");
  assert.equal(delay2.seconds, 900);
});

test("simple: payload pro destičku se z AST vrátí znak po znaku stejný", () => {
  const cases = [
    "F1,D3,F2,D5",
    "F1,D600,F2,D10",
    "F1,D2,F2,D,F5,D",
    "F3,D,F7,D900",
    "F4,D,F5,D60",
    "F1,D,2,ě",
    "LC,D,RC,ENTER,D2",
    "0,1,2,3,4,5,6,7,8,9,+,ě,š,č,ř,ž,ý,á,í,é",
  ];
  cases.forEach((seq) => {
    const { ast: program } = simpleParser.parseSimple(seq);
    assert.equal(simpleParser.toDeviceSequence(program), seq, seq);
  });
});

test("simple: mezery a malá písmena se normalizují jako ve firmwaru", () => {
  const { ast: program } = simpleParser.parseSimple(" f1 , d3 , enter ");
  assert.equal(simpleParser.toDeviceSequence(program), "F1,D3,ENTER");
});

test("simple: neznámý token jen varuje a projde dál na destičku", () => {
  const result = validator.validateSimple("F1,XYZ,D2");
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /XYZ/);
  assert.equal(result.device, "F1,XYZ,D2");
});

test("simple: prázdná sekvence je chyba", () => {
  const result = validator.validateSimple("   ");
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "EMPTY");
});

test("simple: projde stejným compilerem jako complex", () => {
  const { ast: program } = simpleParser.parseSimple("F1,D3");
  const { ir, errors } = compiler.compile(program);
  assert.deepEqual(errors, []);
  assert.ok(ir);
  assert.deepEqual(
    ir.main.code.map((op) => op.op),
    ["LOOP_BEGIN", "LOOP_TEST", "PRESS", "WAIT", "LOOP_NEXT", "LOOP_END"],
  );
});

test("simple: převod na V2 text je platný program", () => {
  const text = simpleParser.simpleToV2Text("F1,D3,F2,D", { loop: true, delayMin: 200, delayMax: 800 });
  assert.equal(
    text,
    ["DOKOLA", "    STISK F1", "    CEKEJ 3s", "    STISK F2", "    CEKEJ NAHODNE 200ms-800ms", "KONEC"].join("\n"),
  );
  assert.equal(validator.validateText(text).ok, true);
});
