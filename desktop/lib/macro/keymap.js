// Klávesy, které umí destička. Jediný zdroj pravdy pro parser, validátor i editor.
// Stejná sada jako COMMANDS v appCore.js a parse_* v src/main.cpp.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.keymap = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FKEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
  const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const CZ_ROW = ["+", "ě", "š", "č", "ř", "ž", "ý", "á", "í", "é"];

  // token v makru -> payload na esp32kbd/command
  const ALIASES = new Map();
  const add = (command, names) => {
    names.forEach((name) => ALIASES.set(name.toUpperCase(), command));
  };

  FKEYS.forEach((key) => add(key, [key]));
  DIGITS.forEach((key) => add(key, [key]));
  CZ_ROW.forEach((key) => ALIASES.set(key.toUpperCase(), key));
  CZ_ROW.forEach((key) => ALIASES.set(key, key));
  add("ENTER", ["ENTER", "ENT", "RETURN", "RET"]);
  add("LC", ["LC", "LMB", "LCLICK", "LEFT", "KLIK"]);
  add("RC", ["RC", "RMB", "RCLICK", "RIGHT"]);

  // Klávesy, které lidi zkoušejí, ale destička je (zatím) neumí — kvůli hlášce.
  const UNSUPPORTED = new Set([
    "SPACE", "MEZERNIK", "MEZERNÍK", "TAB", "ESC", "ESCAPE", "SHIFT", "CTRL", "ALT",
    "BACKSPACE", "DELETE", "UP", "DOWN", "HOME", "END", "PAGEUP", "PAGEDOWN",
    ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ]);

  // Klávesy pro nabídku v editoru (v pořadí, jak jsou na padu).
  const PALETTE = [...FKEYS, ...DIGITS, ...CZ_ROW, "ENTER", "LC", "RC"];

  function normalizeKey(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) {
      return null;
    }
    if (CZ_ROW.includes(text)) {
      return text;
    }
    return ALIASES.get(text.toUpperCase()) || null;
  }

  function isKnownUnsupported(raw) {
    const text = String(raw == null ? "" : raw).trim().toUpperCase();
    return UNSUPPORTED.has(text);
  }

  function supportedList() {
    return PALETTE.slice();
  }

  return { FKEYS, DIGITS, CZ_ROW, PALETTE, normalizeKey, isKnownUnsupported, supportedList };
});
