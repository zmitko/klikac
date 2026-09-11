// Lexer jazyka V2. Jazyk je řádkově orientovaný, takže tokenizujeme po řádcích
// a parser pak pracuje se seznamem řádků.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({ ast: require("./ast") });
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.lexer = factory(root.KlikacMacro);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (dep) {
  const ast = dep.ast;

  const UNIT_WORDS = new Set(["ms", "s", "min", "h"]);
  const OPERATOR_STARTS = "=!<>";

  function isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }

  // Identifikátory: písmena (i česká), číslice, podtržítko.
  function isWordChar(ch) {
    return /[\p{L}\p{N}_]/u.test(ch);
  }

  function tokenizeLine(text, line) {
    const tokens = [];
    const errors = [];
    let i = 0;
    const push = (type, value, col, extra) => {
      tokens.push({ type, value, line, col, ...(extra || {}) });
    };

    while (i < text.length) {
      const ch = text[i];
      if (ch === " " || ch === "\t") {
        i += 1;
        continue;
      }
      if (ch === "#") {
        push("comment", text.slice(i + 1).trim(), i + 1);
        break;
      }
      if (ch === "\"") {
        const end = text.indexOf("\"", i + 1);
        if (end < 0) {
          errors.push({ line, col: i + 1, message: "Neuzavřený text v uvozovkách." });
          push("string", text.slice(i + 1), i + 1);
          break;
        }
        push("string", text.slice(i + 1, end), i + 1);
        i = end + 1;
        continue;
      }
      if (isDigit(ch)) {
        let j = i;
        while (j < text.length && isDigit(text[j])) {
          j += 1;
        }
        const digits = text.slice(i, j);
        // čas HH:MM
        if (text[j] === ":" && isDigit(text[j + 1] || "") && isDigit(text[j + 2] || "")) {
          const raw = `${digits}:${text.slice(j + 1, j + 3)}`;
          const minutes = ast.timeToMinutes(raw);
          if (minutes == null) {
            errors.push({ line, col: i + 1, message: `Neplatný čas „${raw}“. Čekám HH:MM, třeba 18:00.` });
          }
          push("time", raw, i + 1, { minutes: minutes == null ? 0 : minutes });
          i = j + 3;
          continue;
        }
        // jednotka nebo „x“ hned za číslem
        let k = j;
        while (k < text.length && /\p{L}/u.test(text[k])) {
          k += 1;
        }
        const suffix = text.slice(j, k);
        if (!suffix) {
          push("number", Number(digits), i + 1);
          i = j;
          continue;
        }
        const lower = suffix.toLowerCase();
        if (UNIT_WORDS.has(lower)) {
          push("duration", Number(digits) * ast.unitMs(lower), i + 1, { raw: `${digits}${lower}` });
          i = k;
          continue;
        }
        if (lower === "x") {
          push("number", Number(digits), i + 1);
          push("word", "x", j + 1);
          i = k;
          continue;
        }
        errors.push({
          line,
          col: i + 1,
          message: `Neznámá jednotka „${suffix}“ u čísla ${digits}. Použij ms, s, min, h nebo x.`,
        });
        push("number", Number(digits), i + 1);
        i = k;
        continue;
      }
      if (OPERATOR_STARTS.includes(ch)) {
        const two = text.slice(i, i + 2);
        if (two === ">=" || two === "<=" || two === "!=" || two === "==") {
          push("op", two === "==" ? "=" : two, i + 1);
          i += 2;
          continue;
        }
        if (ch === "!") {
          errors.push({ line, col: i + 1, message: "Osamocené „!“. Nerovnost se píše !=." });
          i += 1;
          continue;
        }
        push("op", ch, i + 1);
        i += 1;
        continue;
      }
      if (ch === "(" || ch === ")" || ch === "," || ch === "%" || ch === ":" || ch === "-") {
        push("punct", ch, i + 1);
        i += 1;
        continue;
      }
      if (ch === "+") {
        // „+“ je i klávesa horní řady, ne operátor
        push("word", "+", i + 1);
        i += 1;
        continue;
      }
      if (isWordChar(ch)) {
        let j = i;
        while (j < text.length && isWordChar(text[j])) {
          j += 1;
        }
        push("word", text.slice(i, j), i + 1);
        i = j;
        continue;
      }
      errors.push({ line, col: i + 1, message: `Neznámý znak „${ch}“.` });
      i += 1;
    }
    return { tokens, errors };
  }

  // Vrací { lines: [{ line, indent, text, tokens }], errors }
  function tokenize(source) {
    const rawLines = String(source == null ? "" : source).replace(/\r\n?/g, "\n").split("\n");
    const lines = [];
    const errors = [];
    rawLines.forEach((raw, index) => {
      const line = index + 1;
      const trimmed = raw.trim();
      if (!trimmed) {
        return;
      }
      const result = tokenizeLine(raw, line);
      result.errors.forEach((err) => errors.push({ ...err, code: "SYNTAX" }));
      if (!result.tokens.length) {
        return;
      }
      lines.push({
        line,
        text: trimmed,
        indent: raw.length - raw.trimStart().length,
        tokens: result.tokens,
      });
    });
    return { lines, errors };
  }

  return { tokenize, tokenizeLine };
});
