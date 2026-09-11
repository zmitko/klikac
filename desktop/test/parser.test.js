const test = require("node:test");
const assert = require("node:assert/strict");
const { parser, serialize, ast } = require("../lib/macro");

function parse(text) {
  const result = parser.parseProgram(text);
  assert.deepEqual(result.errors, [], `nečekané chyby: ${JSON.stringify(result.errors)}`);
  return result.ast;
}

test("parser: příkazy nejsou citlivé na velikost písmen", () => {
  const program = parse("opakuj 3x\n  stisk f1\n  cekej 2s\nkonec");
  assert.equal(program.body[0].kind, "Repeat");
  assert.equal(program.body[0].body[0].key, "F1");
});

test("parser: čekání ve všech jednotkách", () => {
  const program = parse("CEKEJ 500ms\nCEKEJ 3s\nCEKEJ 2min\nCEKEJ 1h");
  assert.deepEqual(program.body.map((node) => node.ms), [500, 3000, 120000, 3600000]);
});

test("parser: náhodné čekání a čekání do času", () => {
  const program = parse("CEKEJ NAHODNE 2s-5s\nCEKEJ DO 18:00");
  assert.deepEqual(
    [program.body[0].mode, program.body[0].minMs, program.body[0].maxMs],
    ["random", 2000, 5000],
  );
  assert.deepEqual([program.body[1].mode, program.body[1].time], ["until", "18:00"]);
});

test("parser: vnořené cykly drží hierarchii", () => {
  const program = parse([
    "OPAKUJ 5x",
    "    STISK F1",
    "    CEKEJ 3s",
    "    OPAKUJ 3x",
    "        STISK 1",
    "        CEKEJ 2s",
    "    KONEC",
    "    CEKEJ 5s",
    "KONEC",
  ].join("\n"));
  const outer = program.body[0];
  assert.equal(outer.body.length, 4);
  const inner = outer.body[2];
  assert.equal(inner.kind, "Repeat");
  assert.equal(inner.body.length, 2);
  assert.equal(inner.body[0].key, "1");
});

test("parser: POKUD s JINAK a logickými operátory", () => {
  const program = parse([
    "NASTAV POCET = 0",
    "POKUD POCET >= 5 A POCET < 10",
    "    STISK F1",
    "JINAK",
    "    STISK F2",
    "KONEC",
  ].join("\n"));
  const branch = program.body[1];
  assert.equal(branch.cond.op, "A");
  assert.equal(branch.cond.left.op, ">=");
  assert.equal(branch.body[0].key, "F1");
  assert.equal(branch.elseBody[0].key, "F2");
});

test("parser: proměnné, TED, UPLYNULO a CAS", () => {
  const program = parse([
    "NASTAV START = TED",
    "NASTAV X = NAHODNE 1-100",
    "ZVYS X O 5",
    "SNIZ X O 2",
    "POKUD UPLYNULO START >= 30s",
    "    STISK F1",
    "KONEC",
    "POKUD CAS >= 18:00",
    "    STOP",
    "KONEC",
  ].join("\n"));
  assert.equal(program.body[0].value.kind, "Now");
  assert.deepEqual([program.body[1].value.min, program.body[1].value.max], [1, 100]);
  assert.equal(program.body[2].kind, "Inc");
  assert.equal(program.body[3].kind, "Dec");
  assert.equal(program.body[4].cond.left.kind, "Elapsed");
  assert.equal(program.body[4].cond.right.ms, 30000);
  assert.equal(program.body[5].cond.left.kind, "Clock");
  assert.equal(program.body[5].cond.right.minutes, 18 * 60);
});

test("parser: definice makra s parametrem a volání", () => {
  const program = parse([
    "MAKRO M1(POCET)",
    "    OPAKUJ POCET x",
    "        STISK F1",
    "    KONEC",
    "KONEC",
    "SPUST M1(5)",
  ].join("\n"));
  assert.equal(program.macros.length, 1);
  assert.deepEqual(program.macros[0].params, ["POCET"]);
  assert.equal(program.macros[0].body[0].count.name, "POCET");
  assert.equal(program.body[0].kind, "Call");
  assert.equal(program.body[0].args[0].value, 5);
});

test("parser: NAHODNE rovnoměrné i vážené", () => {
  const even = parse("NAHODNE\n    STISK F1\nNEBO\n    STISK F2\nNEBO\n    STISK F3\nKONEC");
  assert.equal(even.body[0].branches.length, 3);
  assert.deepEqual(even.body[0].branches.map((b) => b.weight), [null, null, null]);

  const weighted = parse([
    "NAHODNE",
    "    70%:",
    "        STISK F2",
    "    20%:",
    "        STISK F3",
    "    10%:",
    "        STISK F4",
    "KONEC",
  ].join("\n"));
  assert.deepEqual(weighted.body[0].branches.map((b) => Number(b.weight)), [70, 20, 10]);
  assert.equal(weighted.body[0].branches[0].body[0].key, "F2");
});

test("parser: PO DOBU, KAZDYCH, BREAK, CONTINUE, VYPIS a komentáře", () => {
  const program = parse([
    "# tohle je komentář",
    "PO DOBU 30s",
    "    STISK F1",
    "KONEC",
    "KAZDYCH 10s",
    "    VYPIS \"tik\"",
    "KONEC",
    "DOKOLA",
    "    CONTINUE",
    "    BREAK",
    "KONEC",
  ].join("\n"));
  assert.equal(program.body[0].kind, "Comment");
  assert.equal(program.body[1].ms, 30000);
  assert.equal(program.body[2].ms, 10000);
  assert.equal(program.body[2].body[0].value.value, "tik");
  assert.deepEqual(program.body[3].body.map((n) => n.kind), ["Continue", "Break"]);
});

test("parser: serializace AST se dá znovu parsnout na totéž (fixpoint)", () => {
  const source = [
    "MAKRO M1(POCET)",
    "    OPAKUJ POCET x",
    "        STISK F1",
    "        CEKEJ NAHODNE 2s-5s",
    "    KONEC",
    "KONEC",
    "",
    "NASTAV POCET = 0",
    "DOKOLA",
    "    ZVYS POCET O 1",
    "    POKUD POCET >= 3 NEBO CAS >= 18:00",
    "        SPUST M1(2)",
    "        BREAK",
    "    JINAK",
    "        NAHODNE",
    "            70%:",
    "                STISK F2",
    "            30%:",
    "                STISK F3",
    "        KONEC",
    "    KONEC",
    "    CEKEJ DO 6:30",
    "KONEC",
  ].join("\n");
  const first = serialize.toText(parse(source));
  const second = serialize.toText(parse(first));
  assert.equal(first, second);
  assert.equal(first, serialize.toText(parse(second)));
});

test("parser: annotate přiřadí uzlům řádky odpovídající textu", () => {
  const program = parse("OPAKUJ 2x\n    STISK F1\nKONEC");
  const { text, byLine } = serialize.annotate(program);
  assert.equal(text.split("\n").length, 3);
  assert.equal(byLine.get(1), program.body[0].id);
  assert.equal(byLine.get(2), program.body[0].body[0].id);
  assert.equal(program.body[0].body[0].line, 2);
});

test("parser: nápověda existuje ke každé konstrukci", () => {
  const help = require("../lib/macro").help;
  ast.CONSTRUCTS.forEach((construct) => {
    const entry = help.helpFor(construct.id);
    assert.equal(entry.id, construct.id, construct.id);
    assert.ok(entry.summary, construct.id);
    assert.ok(entry.syntax, construct.id);
    assert.ok(entry.example, construct.id);
  });
});
