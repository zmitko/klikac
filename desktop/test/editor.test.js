// Operace, na kterých stojí vizuální editor: vkládání, přesun, zanoření,
// vysunutí, duplikace a mazání konstrukcí ve stromu.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ast, parser, serialize, validator, help } = require("../lib/macro");

function shape(program) {
  return serialize.toText(program);
}

test("editor: konstrukce se vloží do těla cyklu", () => {
  const program = ast.newProgram();
  const loop = ast.repeat(ast.num(5), []);
  program.body.push(loop);
  assert.equal(ast.insertInto(program, loop.id, "body", ast.press("F1")), true);
  assert.equal(ast.insertInto(program, loop.id, "body", ast.waitFixed(3000)), true);
  assert.equal(shape(program), ["OPAKUJ 5x", "    STISK F1", "    CEKEJ 3s", "KONEC"].join("\n"));
});

test("editor: POKUD jde vložit do OPAKUJ a OPAKUJ do POKUD", () => {
  const program = ast.newProgram();
  const outer = ast.repeat(ast.num(5), []);
  program.body.push(outer);
  const branch = ast.ifStmt(ast.binary(">=", ast.varRef("X"), ast.num(5)), []);
  ast.insertInto(program, outer.id, "body", branch);
  const inner = ast.repeat(ast.num(3), [ast.press("F1")]);
  ast.insertInto(program, branch.id, "body", inner);
  assert.equal(shape(program), [
    "OPAKUJ 5x",
    "    POKUD X >= 5",
    "        OPAKUJ 3x",
    "            STISK F1",
    "        KONEC",
    "    KONEC",
    "KONEC",
  ].join("\n"));
  const reparsed = parser.parseProgram(shape(program));
  assert.deepEqual(reparsed.errors, []);
  assert.equal(shape(reparsed.ast), shape(program));
});

test("editor: přesun nahoru a dolů mění pořadí", () => {
  const program = parser.parseProgram("STISK F1\nSTISK F2\nSTISK F3").ast;
  const second = program.body[1];
  assert.equal(ast.moveNode(program, second.id, -1), true);
  assert.deepEqual(program.body.map((n) => n.key), ["F2", "F1", "F3"]);
  assert.equal(ast.moveNode(program, second.id, 1), true);
  assert.deepEqual(program.body.map((n) => n.key), ["F1", "F2", "F3"]);
  assert.equal(ast.moveNode(program, program.body[0].id, -1), false);
});

test("editor: zanoření přesune konstrukci do bloku nad ní", () => {
  const program = parser.parseProgram("OPAKUJ 2x\nKONEC\nSTISK F1").ast;
  const press = program.body[1];
  assert.equal(ast.nestNode(program, press.id), true);
  assert.equal(shape(program), ["OPAKUJ 2x", "    STISK F1", "KONEC"].join("\n"));
});

test("editor: zanoření nejde, když nad konstrukcí není blok", () => {
  const program = parser.parseProgram("STISK F1\nSTISK F2").ast;
  assert.equal(ast.nestNode(program, program.body[1].id), false);
  assert.equal(ast.nestNode(program, program.body[0].id), false);
});

test("editor: vysunutí dostane konstrukci z bloku za blok", () => {
  const program = parser.parseProgram("OPAKUJ 2x\n    STISK F1\n    STISK F2\nKONEC").ast;
  const inner = program.body[0].body[0];
  assert.equal(ast.outdentNode(program, inner.id), true);
  assert.equal(shape(program), ["OPAKUJ 2x", "    STISK F2", "KONEC", "STISK F1"].join("\n"));
});

test("editor: duplikace vytvoří kopii s novými id", () => {
  const program = parser.parseProgram("OPAKUJ 2x\n    STISK F1\nKONEC").ast;
  const loop = program.body[0];
  const copy = ast.duplicateNode(program, loop.id);
  assert.ok(copy);
  assert.notEqual(copy.id, loop.id);
  assert.notEqual(copy.body[0].id, loop.body[0].id);
  assert.equal(program.body.length, 2);
  assert.equal(shape(program), [
    "OPAKUJ 2x",
    "    STISK F1",
    "KONEC",
    "OPAKUJ 2x",
    "    STISK F1",
    "KONEC",
  ].join("\n"));
});

test("editor: mazání odstraní i vnořený obsah", () => {
  const program = parser.parseProgram("OPAKUJ 2x\n    STISK F1\nKONEC\nSTISK F2").ast;
  ast.removeNode(program, program.body[0].id);
  assert.equal(shape(program), "STISK F2");
});

test("editor: NAHODNE má vlastní místa pro vkládání do variant", () => {
  const program = ast.newProgram();
  const choice = ast.choice([ast.choiceBranch([]), ast.choiceBranch([])]);
  program.body.push(choice);
  ast.insertInto(program, choice.branches[0].id, "body", ast.press("F1"));
  ast.insertInto(program, choice.branches[1].id, "body", ast.press("F2"));
  assert.equal(shape(program), ["NAHODNE", "    STISK F1", "NEBO", "    STISK F2", "KONEC"].join("\n"));
});

test("editor: vysunutí z varianty NAHODNE skončí za celou konstrukcí", () => {
  const program = parser.parseProgram("NAHODNE\n    STISK F1\nNEBO\n    STISK F2\nKONEC").ast;
  const first = program.body[0].branches[0].body[0];
  assert.equal(ast.outdentNode(program, first.id), true);
  assert.equal(shape(program), ["NAHODNE", "NEBO", "    STISK F2", "KONEC", "STISK F1"].join("\n"));
});

test("editor: MAKRO patří do sekce definic, ne do programu", () => {
  const program = ast.newProgram();
  const spec = ast.constructById("macroDef");
  assert.equal(spec.topLevel, true);
  program.macros.push(spec.create());
  ast.insertInto(program, program.macros[0].id, "body", ast.press("F1"));
  program.body.push(ast.call("M1", []));
  const result = validator.validateProgram(program, []);
  assert.equal(result.ok, true);
});

test("editor: každá konstrukce z palety umí vytvořit platný uzel", () => {
  ast.CONSTRUCTS.forEach((construct) => {
    const node = construct.create();
    assert.equal(node.kind, construct.kind, construct.id);
    assert.ok(node.id, construct.id);
    const program = ast.newProgram();
    if (construct.topLevel) {
      program.macros.push(node);
      program.body.push(ast.call(node.name, []));
    } else if (construct.kind === "Break" || construct.kind === "Continue") {
      program.body.push(ast.forever([node]));
    } else {
      program.body.push(node);
    }
    const text = serialize.toText(program);
    const reparsed = parser.parseProgram(text);
    assert.deepEqual(reparsed.errors, [], `${construct.id}: ${text}`);
    assert.equal(serialize.toText(reparsed.ast), text, construct.id);
    assert.ok(help.helpFor(construct.id).title, construct.id);
  });
});

test("editor: nápověda každé konstrukce obsahuje spustitelný příklad", () => {
  ast.CONSTRUCTS.forEach((construct) => {
    const entry = help.helpFor(construct.id);
    const result = validator.validateText(entry.example);
    assert.deepEqual(result.errors, [], `${construct.id}: ${JSON.stringify(result.errors)}`);
    assert.ok(result.ir, construct.id);
  });
});

test("editor: annotate namapuje řádek chyby na uzel v AST", () => {
  const program = parser.parseProgram("OPAKUJ 2x\n    SPUST M9\nKONEC").ast;
  const { byLine } = serialize.annotate(program);
  const result = validator.validateProgram(program, []);
  assert.equal(result.ok, false);
  const error = result.errors[0];
  assert.equal(byLine.get(error.line), program.body[0].body[0].id);
});
