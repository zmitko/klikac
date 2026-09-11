// Validace ve čtyřech vrstvách: syntax -> struktura -> sémantika -> kompilace.
// Chyby spuštění blokují, varování ne.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({
      ast: require("./ast"),
      keymap: require("./keymap"),
      parser: require("./parser"),
      compiler: require("./compiler"),
      simpleParser: require("./simpleParser"),
    });
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.validator = factory(root.KlikacMacro);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (dep) {
  const ast = dep.ast;
  const keymap = dep.keymap;
  const parser = dep.parser;
  const compiler = dep.compiler;
  const simpleParser = dep.simpleParser;

  const LEVELS = [
    { id: "syntax", label: "Syntax je správná" },
    { id: "structure", label: "Struktura bloků je správná" },
    { id: "vars", label: "Všechny proměnné jsou platné" },
    { id: "macros", label: "Všechna makra existují" },
    { id: "params", label: "Parametry a hodnoty jsou správné" },
    { id: "compile", label: "Makro lze zkompilovat" },
  ];

  const CODE_LEVEL = {
    SYNTAX: "syntax",
    STRUCTURE: "structure",
    CTL_OUTSIDE_LOOP: "structure",
    NESTED_MACRO: "structure",
    EMPTY: "structure",
    EMPTY_CHOICE: "structure",
    VAR_UNSET: "vars",
    VAR_NAME: "vars",
    MACRO_UNKNOWN: "macros",
    MACRO_DUP: "macros",
    RECURSION: "macros",
    PARAM_COUNT: "params",
    BAD_KEY: "params",
    BAD_TIME: "params",
    BAD_RANGE: "params",
    BAD_COUNT: "params",
    BAD_WEIGHT: "params",
    COMPILE: "compile",
    UNKNOWN_NODE: "compile",
  };

  const MAX_CALL_DEPTH = 32;

  function levelOf(error) {
    return CODE_LEVEL[error.code] || "compile";
  }

  function dedupe(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.line || 0}|${item.code || ""}|${item.message}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function result(program, rawErrors, rawWarnings, ir) {
    const errors = dedupe(rawErrors);
    const warnings = dedupe(rawWarnings);
    const failed = new Set(errors.map(levelOf));
    return {
      ok: errors.length === 0,
      program: program || null,
      ir: ir || null,
      errors: errors.map((err) => ({ ...err, level: levelOf(err) })),
      warnings,
      levels: LEVELS.map((level) => ({
        ...level,
        ok: level.id === "compile" ? !!ir : !failed.has(level.id),
      })),
      device: ir ? ir.device : null,
    };
  }

  function walkExpr(expr, fn) {
    if (!expr || typeof expr !== "object") {
      return;
    }
    fn(expr);
    if (expr.kind === "Binary") {
      walkExpr(expr.left, fn);
      walkExpr(expr.right, fn);
    } else if (expr.kind === "Unary") {
      walkExpr(expr.expr, fn);
    }
  }

  function collectVariables(program, errors, warnings) {
    const assigned = new Map();
    const timeVars = new Set();
    const read = new Map();
    const params = new Set();

    (program.macros || []).forEach((macro) => {
      (macro.params || []).forEach((p) => params.add(p));
    });

    ast.walk(program, (node) => {
      if (node.kind === "Set") {
        assigned.set(node.name, node.line);
        if (node.value && node.value.kind === "Now") {
          timeVars.add(node.name);
        }
      }
      if (node.kind === "Inc" || node.kind === "Dec") {
        if (!assigned.has(node.name)) {
          assigned.set(node.name, node.line);
        }
        read.set(node.name, node.line);
      }
      const exprs = [];
      if (node.kind === "Set") {
        exprs.push(node.value);
      }
      if (node.kind === "Inc" || node.kind === "Dec") {
        exprs.push(node.by);
      }
      if (node.kind === "If") {
        exprs.push(node.cond);
      }
      if (node.kind === "Repeat") {
        exprs.push(node.count);
      }
      if (node.kind === "Print") {
        exprs.push(node.value);
      }
      if (node.kind === "Call") {
        (node.args || []).forEach((arg) => exprs.push(arg));
      }
      exprs.forEach((expr) => walkExpr(expr, (part) => {
        if (part.kind === "Var") {
          read.set(part.name, node.line);
        }
        if (part.kind === "Elapsed") {
          read.set(part.name, node.line);
          if (!timeVars.has(part.name)) {
            warnings.push({
              line: node.line,
              message: `UPLYNULO ${part.name}: proměnná nikde nedostane TED, počítá se od začátku programu.`,
              code: "ELAPSED_NO_NOW",
            });
          }
        }
      }));
      return true;
    });

    read.forEach((line, name) => {
      if (!assigned.has(name) && !params.has(name)) {
        errors.push({
          line,
          message: `Proměnná ${name} se čte, ale nikde není nastavená (chybí NASTAV ${name} = …).`,
          code: "VAR_UNSET",
        });
      }
    });
    assigned.forEach((line, name) => {
      if (!read.has(name)) {
        warnings.push({
          line,
          message: `Proměnná ${name} je nastavena, ale nikde se nepoužívá.`,
          code: "VAR_UNUSED",
        });
      }
    });
  }

  function collectMacros(program, errors) {
    const defs = new Map();
    (program.macros || []).forEach((macro) => {
      if (defs.has(macro.name)) {
        errors.push({
          line: macro.line,
          message: `Makro ${macro.name} je definované dvakrát.`,
          code: "MACRO_DUP",
        });
        return;
      }
      defs.set(macro.name, macro);
    });
    return defs;
  }

  function checkCalls(program, defs, errors) {
    ast.walk(program, (node) => {
      if (node.kind !== "Call") {
        return true;
      }
      const def = defs.get(node.name);
      if (!def) {
        errors.push({
          line: node.line,
          message: defs.size
            ? `Makro ${node.name} neexistuje. Známá makra: ${[...defs.keys()].join(", ")}.`
            : `Makro ${node.name} neexistuje. Nejdřív ho definuj přes MAKRO ${node.name} … KONEC.`,
          code: "MACRO_UNKNOWN",
        });
        return true;
      }
      const expected = (def.params || []).length;
      const got = (node.args || []).length;
      if (expected !== got) {
        errors.push({
          line: node.line,
          message: `Makro ${node.name} očekává ${expected} parametr${expected === 1 ? "" : expected >= 2 && expected <= 4 ? "y" : "ů"}, dostalo ${got}.`,
          code: "PARAM_COUNT",
        });
      }
      return true;
    });
  }

  // M1 -> M2 -> M1 se musí najít před spuštěním.
  function checkRecursion(program, defs, errors) {
    const edges = new Map();
    const addEdges = (name, body) => {
      const list = edges.get(name) || [];
      ast.walk({ kind: "Program", id: `edges-${name}`, macros: [], body }, (node) => {
        if (node.kind === "Call") {
          list.push({ name: node.name, line: node.line });
        }
        return true;
      });
      edges.set(name, list);
    };
    defs.forEach((macro, name) => addEdges(name, macro.body));

    const state = new Map();
    const stack = [];
    const reported = new Set();

    const visit = (name) => {
      state.set(name, "open");
      stack.push(name);
      (edges.get(name) || []).forEach((edge) => {
        if (!defs.has(edge.name)) {
          return;
        }
        if (state.get(edge.name) === "open") {
          const from = stack.indexOf(edge.name);
          const path = [...stack.slice(from), edge.name];
          const key = path.join(">");
          if (!reported.has(key)) {
            reported.add(key);
            errors.push({
              line: edge.line,
              message: `Cyklické volání maker: ${path.join(" → ")}. V2 rekurzi nepodporuje.`,
              code: "RECURSION",
            });
          }
          return;
        }
        if (!state.has(edge.name)) {
          visit(edge.name);
        }
      });
      stack.pop();
      state.set(name, "done");
    };

    defs.forEach((_macro, name) => {
      if (!state.has(name)) {
        visit(name);
      }
    });
  }

  function checkValues(program, errors, warnings) {
    ast.walk(program, (node) => {
      switch (node.kind) {
        case "Press": {
          const key = keymap.normalizeKey(node.raw || node.key);
          if (!key) {
            const known = keymap.isKnownUnsupported(node.raw || node.key);
            errors.push({
              line: node.line,
              message: known
                ? `STISK ${node.key}: tuhle klávesu destička neumí. Umí ${keymap.supportedList().join(" ")}.`
                : `STISK ${node.key}: neznámá klávesa. Použij ${keymap.supportedList().join(" ")}.`,
              code: "BAD_KEY",
            });
          }
          break;
        }
        case "Wait": {
          if (node.mode === "fixed" && !(Number(node.ms) > 0)) {
            errors.push({ line: node.line, message: "CEKEJ: doba musí být větší než 0.", code: "BAD_RANGE" });
          }
          if (node.mode === "random") {
            if (!(Number(node.minMs) > 0) || !(Number(node.maxMs) > 0)) {
              errors.push({ line: node.line, message: "CEKEJ NAHODNE: obě hodnoty musí být větší než 0.", code: "BAD_RANGE" });
            } else if (Number(node.minMs) > Number(node.maxMs)) {
              errors.push({ line: node.line, message: "CEKEJ NAHODNE: první hodnota musí být menší než druhá.", code: "BAD_RANGE" });
            }
          }
          if (node.mode === "until" && ast.timeToMinutes(node.time) == null) {
            errors.push({ line: node.line, message: `CEKEJ DO ${node.time}: čas musí být HH:MM.`, code: "BAD_TIME" });
          }
          break;
        }
        case "Repeat": {
          const count = compiler.constValue(node.count);
          if (count != null && (!Number.isInteger(count) || count <= 0)) {
            errors.push({
              line: node.line,
              message: "OPAKUJ: počet musí být celé číslo větší než 0.",
              code: "BAD_COUNT",
            });
          }
          if (!node.body.length) {
            warnings.push({ line: node.line, message: "OPAKUJ nemá v těle žádnou konstrukci.", code: "EMPTY_BODY" });
          }
          break;
        }
        case "During":
        case "Every": {
          const word = node.kind === "During" ? "PO DOBU" : "KAZDYCH";
          if (!(Number(node.ms) > 0)) {
            errors.push({ line: node.line, message: `${word}: doba musí být větší než 0.`, code: "BAD_RANGE" });
          }
          if (!node.body.length) {
            warnings.push({ line: node.line, message: `${word} nemá v těle žádnou konstrukci.`, code: "EMPTY_BODY" });
          }
          break;
        }
        case "Forever": {
          if (!node.body.length) {
            warnings.push({ line: node.line, message: "DOKOLA nemá v těle žádnou konstrukci.", code: "EMPTY_BODY" });
          }
          break;
        }
        case "If": {
          if (!node.body.length && !(node.elseBody || []).length) {
            warnings.push({ line: node.line, message: "POKUD nemá co provést.", code: "EMPTY_BODY" });
          }
          walkExpr(node.cond, (part) => {
            if (part.kind === "RandRange") {
              errors.push({
                line: node.line,
                message: "POKUD: NAHODNE se dá použít jen v NASTAV, ne v podmínce.",
                code: "BAD_RANGE",
              });
            }
          });
          if (node.cond && node.cond.kind !== "Binary" && node.cond.kind !== "Unary" && node.cond.kind !== "Var") {
            warnings.push({
              line: node.line,
              message: "POKUD: podmínka bez porovnání je platná jen jako test „nenulové“ hodnoty.",
              code: "COND_SHAPE",
            });
          }
          break;
        }
        case "Choice": {
          const branches = node.branches || [];
          const weighted = branches.filter((b) => b.weight != null);
          if (weighted.length && weighted.length !== branches.length) {
            errors.push({
              line: node.line,
              message: "NAHODNE: buď měj procenta u všech variant, nebo u žádné.",
              code: "BAD_WEIGHT",
            });
          }
          if (weighted.length === branches.length && branches.length) {
            const sum = weighted.reduce((acc, b) => acc + (Number(b.weight) || 0), 0);
            if (sum > 100) {
              errors.push({ line: node.line, message: `NAHODNE: procenta dávají ${sum} %, nesmí přesáhnout 100 %.`, code: "BAD_WEIGHT" });
            } else if (sum !== 100) {
              warnings.push({ line: node.line, message: `NAHODNE: procenta dávají ${sum} %, zbytek se nic neprovede.`, code: "WEIGHT_SUM" });
            }
          }
          if (branches.length < 2) {
            warnings.push({ line: node.line, message: "NAHODNE má jen jednu variantu.", code: "SINGLE_CHOICE" });
          }
          branches.forEach((branch) => {
            if (!branch.body.length) {
              warnings.push({ line: node.line, message: "NAHODNE: jedna varianta je prázdná.", code: "EMPTY_BODY" });
            }
          });
          break;
        }
        case "MacroDef": {
          if (!node.body.length) {
            warnings.push({ line: node.line, message: `Makro ${node.name} je prázdné.`, code: "EMPTY_BODY" });
          }
          break;
        }
        default:
          break;
      }
      return true;
    });
  }

  function checkReachability(program, defs, warnings) {
    const used = new Set();
    ast.walk(program, (node) => {
      if (node.kind === "Call") {
        used.add(node.name);
      }
      return true;
    });
    defs.forEach((macro, name) => {
      if (!used.has(name)) {
        warnings.push({
          line: macro.line,
          message: `Makro ${name} je definované, ale nikde se nespouští.`,
          code: "MACRO_UNUSED",
        });
      }
    });
  }

  // Validace komplexního makra z textu.
  function validateText(source) {
    const parsed = parser.parseProgram(source);
    return validateProgram(parsed.ast, parsed.errors);
  }

  // Validace komplexního makra z AST (vizuální editor).
  function validateProgram(program, parseErrors) {
    const errors = (parseErrors || []).slice();
    const warnings = [];
    if (!program) {
      return result(null, [{ line: 0, message: "Program chybí.", code: "COMPILE" }], warnings, null);
    }
    if (ast.isEmptyProgram(program)) {
      if (!errors.length) {
        errors.push({ line: 0, message: "Program je prázdný — přidej aspoň jednu konstrukci.", code: "EMPTY" });
      }
      return result(program, errors, warnings, null);
    }
    const defs = collectMacros(program, errors);
    checkCalls(program, defs, errors);
    checkRecursion(program, defs, errors);
    checkValues(program, errors, warnings);
    collectVariables(program, errors, warnings);
    checkReachability(program, defs, warnings);
    if (!(program.body || []).length && defs.size) {
      warnings.push({ line: 0, message: "Program má jen definice maker, žádné se nespouští.", code: "NO_BODY" });
    }

    // Kompilace je čtvrtá vrstva — má smysl až když prošly předchozí tři.
    if (errors.length) {
      return result(program, errors, warnings, null);
    }
    const compiled = compiler.compile(program);
    compiled.errors.forEach((err) => errors.push(err));
    return result(program, errors, warnings, errors.length ? null : compiled.ir);
  }

  // Validace Simple makra (tolerantní kvůli zpětné kompatibilitě).
  function validateSimple(seq, options) {
    const parsed = simpleParser.parseSimple(seq, options);
    const errors = parsed.errors.slice();
    const warnings = parsed.warnings.slice();
    let ir = null;
    if (!errors.length) {
      const compiled = compiler.compile(parsed.ast);
      compiled.errors.forEach((err) => errors.push(err));
      ir = compiled.ir;
    }
    const out = result(parsed.ast, errors, warnings, ir);
    out.tokens = parsed.tokens;
    return out;
  }

  function validateSlot(slot, options) {
    const type = slot && slot.type === ast.MACRO_TYPE.COMPLEX ? ast.MACRO_TYPE.COMPLEX : ast.MACRO_TYPE.SIMPLE;
    if (type === ast.MACRO_TYPE.COMPLEX) {
      return validateText(slot.program || "");
    }
    return validateSimple(slot ? slot.seq : "", options);
  }

  return { validateText, validateProgram, validateSimple, validateSlot, LEVELS, MAX_CALL_DEPTH };
});
