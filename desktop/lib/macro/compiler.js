// Compiler: AST -> IR (plochý seznam instrukcí se skoky).
// Runtime umí jen IR, takže nezvalidované/nezkompilovatelné makro nejde spustit.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({ ast: require("./ast"), keymap: require("./keymap"), simpleParser: require("./simpleParser") });
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.compiler = factory(root.KlikacMacro);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (dep) {
  const ast = dep.ast;
  const keymap = dep.keymap;
  const simpleParser = dep.simpleParser;

  const IR_VERSION = "2.0";
  const MAIN = "__main";

  class Emitter {
    constructor(name, params, errors) {
      this.name = name;
      this.params = params || [];
      this.code = [];
      this.errors = errors;
      this.loops = [];
    }

    emit(instruction) {
      this.code.push(instruction);
      return this.code.length - 1;
    }

    get here() {
      return this.code.length;
    }

    fail(line, message, code) {
      this.errors.push({ line: line || 0, message, code: code || "COMPILE" });
    }
  }

  function compileBody(body, emitter) {
    (body || []).forEach((node) => compileStatement(node, emitter));
  }

  function compileStatement(node, emitter) {
    if (!node || typeof node !== "object") {
      return;
    }
    const line = node.line || 0;
    switch (node.kind) {
      case "Comment":
        break;
      case "Press": {
        const key = keymap.normalizeKey(node.raw || node.key);
        if (!key) {
          emitter.fail(line, `STISK ${node.key}: tuhle klávesu destička neumí.`, "BAD_KEY");
          break;
        }
        emitter.emit({ op: "PRESS", key, line });
        break;
      }
      case "Wait": {
        if (node.mode === "random") {
          emitter.emit({ op: "WAIT", mode: "random", minMs: node.minMs, maxMs: node.maxMs, line });
        } else if (node.mode === "until") {
          const minutes = ast.timeToMinutes(node.time);
          if (minutes == null) {
            emitter.fail(line, `CEKEJ DO ${node.time}: čas musí být HH:MM.`, "BAD_TIME");
            break;
          }
          emitter.emit({ op: "WAIT", mode: "until", minutes, line });
        } else if (node.mode === "delay") {
          emitter.emit({ op: "WAIT", mode: "delay", seconds: Number(node.seconds) || 0, line });
        } else {
          emitter.emit({ op: "WAIT", mode: "fixed", ms: Number(node.ms) || 0, line });
        }
        break;
      }
      case "Set":
        emitter.emit({ op: "SET", name: node.name, expr: node.value, line });
        break;
      case "Inc":
        emitter.emit({ op: "ADD", name: node.name, expr: node.by, sign: 1, line });
        break;
      case "Dec":
        emitter.emit({ op: "ADD", name: node.name, expr: node.by, sign: -1, line });
        break;
      case "Print":
        emitter.emit({ op: "PRINT", expr: node.value, line });
        break;
      case "Stop":
        emitter.emit({ op: "STOP", line });
        break;
      case "Call":
        emitter.emit({ op: "CALL", name: node.name, args: node.args || [], line });
        break;
      case "Break":
      case "Continue": {
        if (!emitter.loops.length) {
          emitter.fail(line, `${node.kind === "Break" ? "BREAK" : "CONTINUE"} funguje jen v cyklu.`, "CTL_OUTSIDE_LOOP");
          break;
        }
        emitter.emit({ op: node.kind === "Break" ? "BREAK" : "CONTINUE", line });
        break;
      }
      case "Repeat":
      case "Forever":
      case "During":
      case "Every":
        compileLoop(node, emitter);
        break;
      case "If":
        compileIf(node, emitter);
        break;
      case "Choice":
        compileChoice(node, emitter);
        break;
      case "MacroDef":
        emitter.fail(line, "MAKRO nelze definovat uvnitř programu, patří na nejvyšší úroveň.", "NESTED_MACRO");
        break;
      default:
        emitter.fail(line, `Neznámá konstrukce ${node.kind}.`, "UNKNOWN_NODE");
        break;
    }
  }

  function loopSpec(node) {
    if (node.kind === "Repeat") {
      return { kind: "repeat", countExpr: node.count };
    }
    if (node.kind === "During") {
      return { kind: "during", ms: Number(node.ms) || 0 };
    }
    if (node.kind === "Every") {
      return { kind: "every", ms: Number(node.ms) || 0 };
    }
    return { kind: "forever" };
  }

  function compileLoop(node, emitter) {
    const line = node.line || 0;
    const begin = emitter.emit({ op: "LOOP_BEGIN", loop: loopSpec(node), testPc: 0, endPc: 0, line });
    const testPc = emitter.emit({ op: "LOOP_TEST", endPc: 0, line });
    emitter.code[begin].testPc = testPc;
    emitter.loops.push({ testPc, begin });
    compileBody(node.body, emitter);
    const nextPc = emitter.emit({ op: "LOOP_NEXT", testPc, line });
    const endPc = emitter.emit({ op: "LOOP_END", line });
    emitter.code[begin].endPc = endPc;
    emitter.code[begin].nextPc = nextPc;
    emitter.code[testPc].endPc = endPc;
    emitter.loops.pop();
  }

  function compileIf(node, emitter) {
    const line = node.line || 0;
    const jump = emitter.emit({ op: "JUMP_IF_NOT", expr: node.cond, to: 0, line });
    compileBody(node.body, emitter);
    if (node.elseBody && node.elseBody.length) {
      const skip = emitter.emit({ op: "JUMP", to: 0, line });
      emitter.code[jump].to = emitter.here;
      compileBody(node.elseBody, emitter);
      emitter.code[skip].to = emitter.here;
      return;
    }
    emitter.code[jump].to = emitter.here;
  }

  function compileChoice(node, emitter) {
    const line = node.line || 0;
    const branches = (node.branches || []).filter((b) => b && Array.isArray(b.body));
    if (!branches.length) {
      emitter.fail(line, "NAHODNE nemá ani jednu variantu.", "EMPTY_CHOICE");
      return;
    }
    const head = emitter.emit({ op: "CHOICE", branches: [], line });
    const jumps = [];
    const targets = [];
    branches.forEach((branch) => {
      targets.push({ weight: branch.weight == null ? null : Number(branch.weight), to: emitter.here });
      compileBody(branch.body, emitter);
      jumps.push(emitter.emit({ op: "JUMP", to: 0, line }));
    });
    const end = emitter.here;
    jumps.forEach((pc) => {
      emitter.code[pc].to = end;
    });
    emitter.code[head].branches = targets;
    emitter.code[head].endPc = end;
  }

  // { ir, errors }
  function compile(program) {
    const errors = [];
    if (!program || program.kind !== "Program") {
      return { ir: null, errors: [{ line: 0, message: "Program chybí.", code: "COMPILE" }] };
    }
    const procs = {};
    (program.macros || []).forEach((macro) => {
      if (!macro || macro.kind !== "MacroDef") {
        return;
      }
      const emitter = new Emitter(macro.name, macro.params, errors);
      compileBody(macro.body, emitter);
      procs[macro.name] = { name: macro.name, params: macro.params || [], code: emitter.code };
    });
    const mainEmitter = new Emitter(MAIN, [], errors);
    compileBody(program.body, mainEmitter);
    const ir = {
      version: IR_VERSION,
      main: { name: MAIN, params: [], code: mainEmitter.code },
      procs,
      device: simpleParser.toDeviceSequence(program),
    };
    return { ir: errors.length ? null : ir, errors };
  }

  // Konstantní hodnota výrazu, když se dá spočítat bez běhu (validace rozsahů).
  function constValue(expr) {
    if (!expr || typeof expr !== "object") {
      return null;
    }
    if (expr.kind === "Num") {
      return expr.value;
    }
    if (expr.kind === "Duration") {
      return expr.ms;
    }
    if (expr.kind === "TimeLit") {
      return expr.minutes;
    }
    return null;
  }

  return { compile, constValue, IR_VERSION, MAIN };
});
