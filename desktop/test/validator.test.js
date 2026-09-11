const test = require("node:test");
const assert = require("node:assert/strict");
const { validator } = require("../lib/macro");

function firstError(text) {
  const result = validator.validateText(text);
  assert.equal(result.ok, false, `čekal jsem chybu pro:\n${text}`);
  return result.errors[0];
}

function levelOk(result, id) {
  return result.levels.find((level) => level.id === id).ok;
}

test("validace: platný program projde všemi vrstvami", () => {
  const result = validator.validateText("OPAKUJ 5x\n    STISK F1\nKONEC");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.ir);
  assert.ok(result.levels.every((level) => level.ok));
});

test("validace 1/syntax: CEKEJ 5xyz je chyba", () => {
  const result = validator.validateText("CEKEJ 5xyz");
  assert.equal(result.ok, false);
  assert.equal(levelOk(result, "syntax"), false);
  assert.match(result.errors[0].message, /jednotka/i);
  assert.equal(result.ir, null);
});

test("validace 1/syntax: neznámý příkaz", () => {
  const error = firstError("STISKNI F1");
  assert.equal(error.code, "SYNTAX");
  assert.match(error.message, /Neznámý příkaz/);
});

test("validace 2/struktura: chybí KONEC", () => {
  const result = validator.validateText("OPAKUJ 5x\n    STISK F1");
  assert.equal(result.ok, false);
  assert.equal(levelOk(result, "structure"), false);
  assert.equal(result.errors[0].code, "STRUCTURE");
  assert.match(result.errors[0].message, /Chybí KONEC konstrukce OPAKUJ/);
  assert.equal(result.errors[0].line, 1);
});

test("validace 2/struktura: KONEC bez otevřené konstrukce", () => {
  const error = firstError("STISK F1\nKONEC");
  assert.equal(error.code, "STRUCTURE");
});

test("validace 2/struktura: BREAK mimo cyklus", () => {
  const error = firstError("BREAK");
  assert.equal(error.code, "CTL_OUTSIDE_LOOP");
});

test("validace 3/sémantika: neznámé makro", () => {
  const result = validator.validateText("SPUST M999");
  assert.equal(result.ok, false);
  assert.equal(levelOk(result, "macros"), false);
  assert.equal(result.errors[0].code, "MACRO_UNKNOWN");
  assert.match(result.errors[0].message, /M999 neexistuje/);
});

test("validace 3/sémantika: špatný počet parametrů", () => {
  const result = validator.validateText([
    "MAKRO M1(A1)",
    "    STISK F1",
    "KONEC",
    "SPUST M1(5,10,20)",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.equal(levelOk(result, "params"), false);
  assert.equal(result.errors[0].code, "PARAM_COUNT");
  assert.match(result.errors[0].message, /očekává 1 parametr, dostalo 3/);
});

test("validace 3/sémantika: rekurze M1 → M2 → M1", () => {
  const result = validator.validateText([
    "MAKRO M1",
    "    SPUST M2",
    "KONEC",
    "MAKRO M2",
    "    SPUST M1",
    "KONEC",
    "SPUST M1",
  ].join("\n"));
  assert.equal(result.ok, false);
  const error = result.errors.find((err) => err.code === "RECURSION");
  assert.ok(error);
  assert.match(error.message, /M1 → M2 → M1/);
});

test("validace 3/sémantika: přímá rekurze M1 → M1", () => {
  const result = validator.validateText("MAKRO M1\n    SPUST M1\nKONEC\nSPUST M1");
  const error = result.errors.find((err) => err.code === "RECURSION");
  assert.ok(error);
  assert.match(error.message, /M1 → M1/);
});

test("validace 3/sémantika: neznámá klávesa", () => {
  const result = validator.validateText("STISK SPACE");
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "BAD_KEY");
  assert.match(result.errors[0].message, /destička neumí/);
});

test("validace 3/sémantika: čtení nenastavené proměnné", () => {
  const result = validator.validateText("POKUD POCET >= 5\n    STISK F1\nKONEC");
  assert.equal(result.ok, false);
  assert.equal(levelOk(result, "vars"), false);
  assert.equal(result.errors[0].code, "VAR_UNSET");
});

test("validace: parametr makra platí jako nastavená proměnná", () => {
  const result = validator.validateText([
    "MAKRO M1(POCET)",
    "    OPAKUJ POCET x",
    "        STISK F1",
    "    KONEC",
    "KONEC",
    "SPUST M1(5)",
  ].join("\n"));
  assert.equal(result.ok, true);
});

test("validace: nepoužitá proměnná je jen varování", () => {
  const result = validator.validateText("NASTAV X = 5\nSTISK F1");
  assert.equal(result.ok, true);
  assert.ok(result.ir);
  const warning = result.warnings.find((warn) => warn.code === "VAR_UNUSED");
  assert.ok(warning);
  assert.match(warning.message, /X je nastavena, ale nikde se nepoužívá/);
});

test("validace: OPAKUJ 0x je chyba, OPAKUJ proměnnou projde", () => {
  assert.equal(firstError("OPAKUJ 0x\n    STISK F1\nKONEC").code, "BAD_COUNT");
  const ok = validator.validateText("NASTAV N = 3\nOPAKUJ N x\n    STISK F1\nKONEC");
  assert.equal(ok.ok, true);
});

test("validace: NAHODNE nad 100 % je chyba, pod 100 % varování", () => {
  const bad = validator.validateText([
    "NAHODNE",
    "    70%:",
    "        STISK F1",
    "    50%:",
    "        STISK F2",
    "KONEC",
  ].join("\n"));
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, "BAD_WEIGHT");

  const warn = validator.validateText([
    "NAHODNE",
    "    70%:",
    "        STISK F1",
    "    20%:",
    "        STISK F2",
    "KONEC",
  ].join("\n"));
  assert.equal(warn.ok, true);
  assert.ok(warn.warnings.some((item) => item.code === "WEIGHT_SUM"));
});

test("validace: prázdný program nejde spustit", () => {
  const result = validator.validateText("   \n\n");
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "EMPTY");
});

test("validace: chyba nese řádek, na který jde v editoru skočit", () => {
  const result = validator.validateText([
    "STISK F1",
    "CEKEJ 2s",
    "SPUST M5",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].line, 3);
});

test("validace: víc chyb se nahlásí naráz", () => {
  const result = validator.validateText([
    "SPUST M5",
    "STISK NECO",
  ].join("\n"));
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map((err) => err.code).sort(), ["BAD_KEY", "MACRO_UNKNOWN"]);
});

test("validace: bez kompilace není IR, takže se nedá spustit", () => {
  const result = validator.validateText("OPAKUJ 5x\n    STISK F1");
  assert.equal(result.ir, null);
  assert.equal(levelOk(result, "compile"), false);
});

test("validace: validateSlot rozliší SIMPLE a COMPLEX", () => {
  const simple = validator.validateSlot({ type: "SIMPLE", seq: "F1,D3" });
  assert.equal(simple.ok, true);
  assert.equal(simple.device, "F1,D3");

  const complex = validator.validateSlot({ type: "COMPLEX", program: "DOKOLA\n STISK F1\nKONEC" });
  assert.equal(complex.ok, true);

  const brokenComplex = validator.validateSlot({ type: "COMPLEX", program: "DOKOLA\n STISK F1" });
  assert.equal(brokenComplex.ok, false);
});
