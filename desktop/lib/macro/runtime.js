// Execution engine nad IR. Nezná obrazovku ani cílovou aplikaci — umí jen
// vlastní proměnné, čas, náhodu a stisky, které posílá dál existujícím kanálem.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.runtime = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_CALL_DEPTH = 32;
  const PRESS_GUARD_MS = 180;
  const YIELD_EVERY = 400;
  // Pojistka proti cyklu, který nic nemačká ani nečeká (třeba prázdné DOKOLA).
  const IDLE_STEP_LIMIT = 5000000;
  const IDLE_REAL_MS = 5000;

  class MacroError extends Error {
    constructor(message, line) {
      super(message);
      this.name = "MacroError";
      this.line = line || 0;
    }
  }

  class MacroVm {
    constructor(ir, options) {
      const opts = options || {};
      this.ir = ir;
      this.press = opts.press || (() => {});
      this.log = opts.log || (() => {});
      this.random = opts.random || Math.random;
      this.clock = opts.now || (() => Date.now());
      this.delayMin = Number(opts.delayMin) || 200;
      this.delayMax = Number(opts.delayMax) || 800;
      this.pressGuardMs = opts.pressGuardMs == null ? PRESS_GUARD_MS : Number(opts.pressGuardMs);
      this.maxDepth = Number(opts.maxDepth) || MAX_CALL_DEPTH;
      this.sleepImpl = opts.sleep || null;
      this.idleStepLimit = Number(opts.idleStepLimit) || IDLE_STEP_LIMIT;
      this.idleRealMs = Number(opts.idleLimitMs) || IDLE_REAL_MS;
      this.lastIoAt = Date.now();
      this.startedAt = this.clock();
      this.vars = new Map();
      this.frames = [];
      this.stopped = false;
      this.running = false;
      this.pendingWake = null;
      this.markIo();
      this.stepsSinceYield = 0;
      this.stats = { presses: 0, waits: 0, steps: 0 };
    }

    // Stisk nebo čekání = program něco dělá, pojistka se vynuluje.
    markIo() {
      this.stepsSinceIo = 0;
      this.lastIoAt = Date.now();
    }

    stop() {
      this.stopped = true;
      if (this.pendingWake) {
        const wake = this.pendingWake;
        this.pendingWake = null;
        wake();
      }
    }

    sleep(ms) {
      const wait = Math.max(0, Math.round(Number(ms) || 0));
      if (this.sleepImpl) {
        return this.sleepImpl(wait, this);
      }
      if (this.stopped) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pendingWake = null;
          resolve();
        }, wait);
        this.pendingWake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }

    randomInt(min, max) {
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      return lo + Math.floor(this.random() * (hi - lo + 1));
    }

    minutesNow() {
      const date = new Date(this.clock());
      return date.getHours() * 60 + date.getMinutes();
    }

    readVar(name, frame) {
      if (frame && frame.locals && Object.prototype.hasOwnProperty.call(frame.locals, name)) {
        return frame.locals[name];
      }
      return this.vars.has(name) ? this.vars.get(name) : 0;
    }

    writeVar(name, value, frame) {
      if (frame && frame.locals && Object.prototype.hasOwnProperty.call(frame.locals, name)) {
        frame.locals[name] = value;
        return;
      }
      this.vars.set(name, value);
    }

    truthy(value) {
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        return value !== 0;
      }
      return !!value;
    }

    evalExpr(expr, frame) {
      if (!expr || typeof expr !== "object") {
        return 0;
      }
      switch (expr.kind) {
        case "Num":
          return expr.value;
        case "Str":
          return expr.value;
        case "Var":
          return this.readVar(expr.name, frame);
        case "Now":
          return this.clock();
        case "Clock":
          return this.minutesNow();
        case "TimeLit":
          return expr.minutes;
        case "Duration":
          return expr.ms;
        case "Elapsed": {
          const base = this.readVar(expr.name, frame);
          const from = typeof base === "number" && base > 0 ? base : this.startedAt;
          return this.clock() - from;
        }
        case "RandRange":
          return this.randomInt(expr.min, expr.max);
        case "Unary":
          return !this.truthy(this.evalExpr(expr.expr, frame));
        case "Binary": {
          if (expr.op === "A") {
            return this.truthy(this.evalExpr(expr.left, frame)) && this.truthy(this.evalExpr(expr.right, frame));
          }
          if (expr.op === "NEBO") {
            return this.truthy(this.evalExpr(expr.left, frame)) || this.truthy(this.evalExpr(expr.right, frame));
          }
          const left = this.evalExpr(expr.left, frame);
          const right = this.evalExpr(expr.right, frame);
          switch (expr.op) {
            case "=":
              return left === right;
            case "!=":
              return left !== right;
            case ">":
              return left > right;
            case "<":
              return left < right;
            case ">=":
              return left >= right;
            case "<=":
              return left <= right;
            default:
              return false;
          }
        }
        default:
          return 0;
      }
    }

    waitMs(instruction) {
      if (instruction.mode === "random") {
        return this.randomInt(instruction.minMs, instruction.maxMs);
      }
      if (instruction.mode === "delay") {
        return (Number(instruction.seconds) || 0) * 1000 + this.randomInt(this.delayMin, this.delayMax);
      }
      if (instruction.mode === "until") {
        const nowMin = this.minutesNow();
        const date = new Date(this.clock());
        const secondsPast = date.getSeconds() * 1000 + date.getMilliseconds();
        let deltaMin = instruction.minutes - nowMin;
        if (deltaMin <= 0) {
          deltaMin += 1440;
        }
        return deltaMin * 60000 - secondsPast;
      }
      return Number(instruction.ms) || 0;
    }

    pushFrame(proc, locals) {
      this.frames.push({ proc, code: proc.code, pc: 0, locals: locals || null, loops: [] });
    }

    async run() {
      if (!this.ir || !this.ir.main) {
        throw new MacroError("Makro není zkompilované.");
      }
      this.running = true;
      this.pushFrame(this.ir.main, null);
      try {
        const reason = await this.loop();
        return { reason };
      } finally {
        this.running = false;
        this.frames = [];
      }
    }

    async loop() {
      while (!this.stopped) {
        const frame = this.frames[this.frames.length - 1];
        if (!frame) {
          return "done";
        }
        if (frame.pc >= frame.code.length) {
          this.frames.pop();
          if (!this.frames.length) {
            return "done";
          }
          continue;
        }
        const instruction = frame.code[frame.pc];
        this.stats.steps += 1;
        this.stepsSinceYield += 1;
        this.stepsSinceIo += 1;
        if (this.stepsSinceIo > this.idleStepLimit
          || (this.stepsSinceIo > YIELD_EVERY && Date.now() - this.lastIoAt > this.idleRealMs)) {
          throw new MacroError("Program běží naprázdno (cyklus bez stisku a bez čekání).", instruction.line);
        }
        if (this.stepsSinceYield >= YIELD_EVERY) {
          this.stepsSinceYield = 0;
          await this.sleep(0);
          if (this.stopped) {
            return "stopped";
          }
        }
        const done = await this.step(frame, instruction);
        if (done) {
          return done;
        }
      }
      return "stopped";
    }

    async step(frame, instruction) {
      switch (instruction.op) {
        case "PRESS": {
          frame.pc += 1;
          this.markIo();
          this.stats.presses += 1;
          await this.press(instruction.key, instruction.line);
          if (this.pressGuardMs > 0) {
            await this.sleep(this.pressGuardMs);
          }
          return null;
        }
        case "WAIT": {
          frame.pc += 1;
          this.markIo();
          this.stats.waits += 1;
          await this.sleep(this.waitMs(instruction));
          return null;
        }
        case "SET": {
          frame.pc += 1;
          this.writeVar(instruction.name, this.evalExpr(instruction.expr, frame), frame);
          return null;
        }
        case "ADD": {
          frame.pc += 1;
          const current = Number(this.readVar(instruction.name, frame)) || 0;
          const delta = Number(this.evalExpr(instruction.expr, frame)) || 0;
          this.writeVar(instruction.name, current + instruction.sign * delta, frame);
          return null;
        }
        case "PRINT": {
          frame.pc += 1;
          const value = this.evalExpr(instruction.expr, frame);
          this.log(typeof value === "number" ? String(value) : String(value), instruction.line);
          return null;
        }
        case "JUMP":
          frame.pc = instruction.to;
          return null;
        case "JUMP_IF_NOT":
          frame.pc = this.truthy(this.evalExpr(instruction.expr, frame)) ? frame.pc + 1 : instruction.to;
          return null;
        case "LOOP_BEGIN": {
          const spec = instruction.loop;
          const loop = {
            kind: spec.kind,
            testPc: instruction.testPc,
            nextPc: instruction.nextPc,
            endPc: instruction.endPc,
            i: 0,
          };
          if (spec.kind === "repeat") {
            const count = Number(this.evalExpr(spec.countExpr, frame));
            if (!Number.isFinite(count) || count <= 0) {
              loop.count = 0;
            } else {
              loop.count = Math.floor(count);
            }
          } else if (spec.kind === "during") {
            loop.deadline = this.clock() + spec.ms;
          } else if (spec.kind === "every") {
            loop.period = spec.ms;
            loop.due = this.clock();
          }
          frame.loops.push(loop);
          frame.pc += 1;
          return null;
        }
        case "LOOP_TEST": {
          const loop = frame.loops[frame.loops.length - 1];
          if (!loop) {
            throw new MacroError("Vnitřní chyba: cyklus bez rámce.", instruction.line);
          }
          if (loop.kind === "repeat" && loop.i >= loop.count) {
            frame.pc = instruction.endPc;
            return null;
          }
          if (loop.kind === "during" && this.clock() >= loop.deadline) {
            frame.pc = instruction.endPc;
            return null;
          }
          if (loop.kind === "every") {
            const delta = loop.due - this.clock();
            if (delta > 0) {
              this.markIo();
              await this.sleep(delta);
              if (this.stopped) {
                return "stopped";
              }
            }
          }
          frame.pc += 1;
          return null;
        }
        case "LOOP_NEXT": {
          const loop = frame.loops[frame.loops.length - 1];
          if (loop) {
            loop.i += 1;
            if (loop.kind === "every") {
              loop.due += loop.period;
              if (loop.due < this.clock()) {
                loop.due = this.clock();
              }
            }
          }
          frame.pc = instruction.testPc;
          return null;
        }
        case "LOOP_END": {
          frame.loops.pop();
          frame.pc += 1;
          return null;
        }
        case "BREAK": {
          const loop = frame.loops[frame.loops.length - 1];
          if (!loop) {
            throw new MacroError("BREAK mimo cyklus.", instruction.line);
          }
          frame.pc = loop.endPc;
          return null;
        }
        case "CONTINUE": {
          const loop = frame.loops[frame.loops.length - 1];
          if (!loop) {
            throw new MacroError("CONTINUE mimo cyklus.", instruction.line);
          }
          frame.pc = loop.nextPc;
          return null;
        }
        case "CHOICE": {
          const target = this.pickBranch(instruction);
          frame.pc = target == null ? instruction.endPc : target;
          return null;
        }
        case "CALL": {
          const proc = this.ir.procs[instruction.name];
          if (!proc) {
            throw new MacroError(`Makro ${instruction.name} neexistuje.`, instruction.line);
          }
          if (this.frames.length >= this.maxDepth) {
            throw new MacroError(`Příliš hluboké volání maker (limit ${this.maxDepth}). Zkontroluj, jestli se makra nevolají dokola.`, instruction.line);
          }
          frame.pc += 1;
          const locals = {};
          (proc.params || []).forEach((param, index) => {
            locals[param] = this.evalExpr((instruction.args || [])[index], frame);
          });
          this.pushFrame(proc, locals);
          return null;
        }
        case "STOP":
          return "stopped";
        case "NOP":
          frame.pc += 1;
          return null;
        default:
          throw new MacroError(`Neznámá instrukce ${instruction.op}.`, instruction.line);
      }
    }

    pickBranch(instruction) {
      const branches = instruction.branches || [];
      if (!branches.length) {
        return null;
      }
      const weighted = branches.every((b) => b.weight != null);
      if (!weighted) {
        return branches[Math.floor(this.random() * branches.length)].to;
      }
      const total = branches.reduce((acc, b) => acc + (Number(b.weight) || 0), 0);
      const span = Math.max(total, 100);
      let roll = this.random() * span;
      for (const branch of branches) {
        roll -= Number(branch.weight) || 0;
        if (roll < 0) {
          return branch.to;
        }
      }
      return null;
    }
  }

  function createVm(ir, options) {
    return new MacroVm(ir, options);
  }

  return { MacroVm, MacroError, createVm, PRESS_GUARD_MS, MAX_CALL_DEPTH };
});
