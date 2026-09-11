const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMacroPack, parseMacroPack, fileNameFor, KIND, FORMAT } = require("../lib/macroPack");

test("pack: COMPLEX s českým názvem jde tam a zpět", () => {
  const pack = buildMacroPack({
    name: "Afk asistence",
    type: "COMPLEX",
    seq: "",
    program: "DOKOLA\n    STISK F1\nKONEC",
  });
  assert.equal(pack.kind, KIND);
  assert.equal(pack.format, FORMAT);
  assert.equal(pack.app, "Klikač");
  const parsed = parseMacroPack(JSON.stringify(pack));
  assert.deepEqual(parsed, {
    name: "Afk asistence",
    type: "COMPLEX",
    seq: "",
    program: "DOKOLA\n    STISK F1\nKONEC",
  });
});

test("pack: SIMPLE zachová sekvenci", () => {
  const parsed = parseMacroPack(buildMacroPack({
    name: "REBUFF",
    type: "SIMPLE",
    seq: "F3,D,F7,D900",
    program: "",
  }));
  assert.equal(parsed.type, "SIMPLE");
  assert.equal(parsed.seq, "F3,D,F7,D900");
});

test("pack: bere i holé JSON bez obalu", () => {
  const parsed = parseMacroPack(JSON.stringify({
    name: "ruční",
    type: "COMPLEX",
    program: "STISK F2",
  }));
  assert.equal(parsed.name, "ruční");
  assert.equal(parsed.program, "STISK F2");
});

test("pack: cizí JSON odmítne", () => {
  assert.throws(() => parseMacroPack('{"foo":1}'), /není exportované makro/);
  assert.throws(() => parseMacroPack("není json"), /JSON/);
});

test("pack: název souboru bez diakritiky", () => {
  assert.equal(fileNameFor("Afk asistence"), "Afk-asistence.klikac.json");
  assert.equal(fileNameFor("J'cob / win?*"), "J-cob-win.klikac.json");
});
