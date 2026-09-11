// Simple makro: „F1,D3,F2,D5“ -> stejný AST jako komplexní makro.
// Zpětná kompatibilita je tady svatá: tokeny si necháváme v původní podobě,
// aby payload pro destičku vyšel znak po znaku stejně jako dřív.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({ ast: require("./ast"), keymap: require("./keymap") });
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.simpleParser = factory(root.KlikacMacro);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (dep) {
  const ast = dep.ast;
  const keymap = dep.keymap;

  const MAX_DELAY_SECONDS = 86400;

  // Firmware si token zvedne na velká písmena (ASCII) a zahodí mezery.
  function normalizeToken(raw) {
    let out = "";
    for (const ch of String(raw == null ? "" : raw)) {
      if (ch === " " || ch === "\t") {
        continue;
      }
      out += ch >= "a" && ch <= "z" ? ch.toUpperCase() : ch;
    }
    return out;
  }

  function parseDelayToken(token) {
    if (!token || token[0] !== "D") {
      return null;
    }
    if (token.length === 1) {
      return { seconds: 0 };
    }
    const rest = token.slice(1);
    if (!/^\d+$/.test(rest)) {
      return null;
    }
    const seconds = Number(rest);
    if (seconds > MAX_DELAY_SECONDS) {
      return null;
    }
    return { seconds };
  }

  // { ast, errors, warnings, tokens }
  function parseSimple(seq, options) {
    const opts = options || {};
    const loop = opts.loop !== false;
    const errors = [];
    const warnings = [];
    const body = [];
    const tokens = [];

    String(seq == null ? "" : seq)
      .split(",")
      .forEach((rawPart) => {
        const token = normalizeToken(rawPart);
        if (!token) {
          return;
        }
        tokens.push(token);
        const delay = parseDelayToken(token);
        if (delay) {
          const node = ast.waitFixed(delay.seconds * 1000);
          node.mode = "delay";
          node.seconds = delay.seconds;
          node.raw = token;
          delete node.ms;
          body.push(node);
          return;
        }
        const key = keymap.normalizeKey(token);
        if (key) {
          const node = ast.press(key);
          node.raw = token;
          body.push(node);
          return;
        }
        // Destička neznámý token přeskočí — necháme ho projít a jen varujeme.
        const node = ast.comment(`neznámý token ${token}`);
        node.raw = token;
        node.unknown = true;
        body.push(node);
        warnings.push({
          message: `Token „${token}“ destička nezná a přeskočí ho.`,
          code: "UNKNOWN_TOKEN",
        });
      });

    if (!body.length) {
      errors.push({ line: 1, message: "Sekvence je prázdná.", code: "EMPTY" });
    }

    const program = ast.program([], []);
    if (loop) {
      const cycle = ast.forever(body);
      cycle.simple = true;
      program.body.push(cycle);
    } else {
      program.body.push(...body);
    }
    program.simple = true;
    return { ast: program, errors, warnings, tokens };
  }

  // Kompilační backend pro destičku: AST -> „F1,D3,F2,D5“.
  // Vrací null, když program do tokenové sekvence nejde (cykly, podmínky, …).
  function toDeviceSequence(program) {
    if (!program || program.kind !== "Program" || (program.macros || []).length) {
      return null;
    }
    const body = program.body || [];
    let flat = body;
    if (body.length === 1 && body[0].kind === "Forever") {
      flat = body[0].body || [];
    }
    const out = [];
    for (const node of flat) {
      if (node.kind === "Press") {
        const key = keymap.normalizeKey(node.raw || node.key);
        if (!key) {
          return null;
        }
        out.push(node.raw ? normalizeToken(node.raw) : key);
        continue;
      }
      if (node.kind === "Wait") {
        if (node.mode === "delay") {
          out.push(node.raw ? normalizeToken(node.raw) : (node.seconds ? `D${node.seconds}` : "D"));
          continue;
        }
        if (node.mode === "fixed" && Number.isFinite(node.ms) && node.ms % 1000 === 0) {
          out.push(`D${node.ms / 1000}`);
          continue;
        }
        return null;
      }
      if (node.kind === "Comment") {
        if (node.unknown && node.raw) {
          out.push(normalizeToken(node.raw));
          continue;
        }
        continue;
      }
      return null;
    }
    return out.length ? out.join(",") : null;
  }

  function isDeviceCompatible(program) {
    return toDeviceSequence(program) !== null;
  }

  // Převod Simple sekvence na čitelný V2 program (nabízíme při přepnutí na COMPLEX).
  function simpleToV2Text(seq, options) {
    const opts = options || {};
    const parsed = parseSimple(seq, { loop: false });
    const lines = [];
    const pad = opts.loop === false ? "" : "    ";
    if (opts.loop !== false) {
      lines.push("DOKOLA");
    }
    (parsed.ast.body || []).forEach((node) => {
      if (node.kind === "Press") {
        lines.push(`${pad}STISK ${node.key}`);
        return;
      }
      if (node.kind === "Wait") {
        const seconds = Number(node.seconds) || 0;
        const dmin = Number(opts.delayMin) || 200;
        const dmax = Number(opts.delayMax) || 800;
        if (seconds > 0) {
          lines.push(`${pad}CEKEJ ${seconds}s`);
        } else {
          lines.push(`${pad}CEKEJ NAHODNE ${dmin}ms-${dmax}ms`);
        }
        return;
      }
      if (node.kind === "Comment" && node.unknown) {
        lines.push(`${pad}# ${node.text}`);
      }
    });
    if (opts.loop !== false) {
      lines.push("KONEC");
    }
    return lines.join("\n");
  }

  return { parseSimple, toDeviceSequence, isDeviceCompatible, simpleToV2Text, normalizeToken };
});
