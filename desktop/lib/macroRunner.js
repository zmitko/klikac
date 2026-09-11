// Běh komplexních maker v aplikaci. Výstupem jsou obyčejné příkazy na
// esp32kbd/command, takže se mačká přes stejný kanál jako klávesnice v UI.
const { validator, runtime, MACRO_TYPE } = require("./macro");

const RESTART_GUARD_MS = 250;

class MacroRunner {
  constructor({ press, onLog, onChange, onIdle }) {
    this.pressFn = press;
    this.onLog = onLog;
    this.onChange = onChange;
    this.onIdle = onIdle;
    this.jobs = new Map();
  }

  log(message) {
    if (typeof this.onLog === "function") {
      this.onLog("makro", message);
    }
  }

  emit() {
    if (typeof this.onChange === "function") {
      this.onChange();
    }
  }

  isRunning() {
    return this.jobs.size > 0;
  }

  snapshot() {
    return {
      running: this.jobs.size > 0,
      slots: [...this.jobs.values()].map((job) => ({
        index: job.index,
        name: job.name,
        state: job.state,
        error: job.error || "",
        errorLine: job.errorLine || 0,
        runs: job.runs,
        presses: job.presses,
      })),
    };
  }

  // Zvaliduje všechna komplexní makra. Vrací { ok, problems:[{index,name,errors}] }.
  validate(slots) {
    const problems = [];
    const ready = [];
    (slots || []).forEach((slot) => {
      if (slot.type !== MACRO_TYPE.COMPLEX) {
        return;
      }
      const result = validator.validateText(slot.program || "");
      if (!result.ok) {
        problems.push({ index: slot.index, name: slot.name, errors: result.errors });
        return;
      }
      ready.push({ slot, ir: result.ir, warnings: result.warnings });
    });
    return { ok: problems.length === 0, problems, ready };
  }

  start(slots, options) {
    const opts = options || {};
    const check = this.validate(slots);
    if (!check.ok) {
      const first = check.problems[0];
      const label = first.name ? `${first.index + 1} (${first.name})` : String(first.index + 1);
      const detail = first.errors[0];
      const err = new Error(`Makro ${label} má chyby: ${detail.message}${detail.line ? ` (řádek ${detail.line})` : ""}`);
      err.code = "MACRO_INVALID";
      err.problems = check.problems;
      throw err;
    }
    this.stop();
    check.ready.forEach((entry) => {
      entry.warnings.forEach((warn) => {
        this.log(`${entry.slot.index + 1}: ⚠ ${warn.message}${warn.line ? ` (řádek ${warn.line})` : ""}`);
      });
      this.launch(entry.slot, entry.ir, opts);
    });
    if (check.ready.length) {
      this.emit();
    }
    return check.ready.length;
  }

  launch(slot, ir, opts) {
    const job = {
      index: slot.index,
      name: slot.name || "",
      state: "running",
      error: "",
      errorLine: 0,
      runs: 0,
      presses: 0,
      vm: null,
      stopped: false,
    };
    this.jobs.set(slot.index, job);
    const label = slot.name ? `${slot.index + 1} (${slot.name})` : String(slot.index + 1);
    this.log(`${label}: start · ${ir.main.code.length} instrukcí`);

    const cycle = async () => {
      while (!job.stopped) {
        const startedAt = Date.now();
        const vm = runtime.createVm(ir, {
          press: (key) => {
            job.presses += 1;
            return this.pressFn(key);
          },
          log: (message) => this.log(`${label}: ${message}`),
          delayMin: opts.delayMin,
          delayMax: opts.delayMax,
        });
        job.vm = vm;
        const result = await vm.run();
        job.runs += 1;
        if (job.stopped || result.reason === "stopped") {
          return result.reason;
        }
        if (!opts.loop) {
          return "done";
        }
        if (Date.now() - startedAt < RESTART_GUARD_MS) {
          await new Promise((resolve) => setTimeout(resolve, RESTART_GUARD_MS));
        }
        if (job.stopped) {
          return "stopped";
        }
      }
      return "stopped";
    };

    cycle()
      .then((reason) => {
        if (job.stopped) {
          return;
        }
        job.state = reason === "stopped" ? "stopped" : "done";
        this.log(`${label}: ${reason === "stopped" ? "STOP z programu" : "dokončeno"} · ${job.presses} stisků`);
        this.finish(slot.index);
      })
      .catch((err) => {
        job.state = "error";
        job.error = err.message;
        job.errorLine = err.line || 0;
        this.log(`${label}: chyba — ${err.message}${err.line ? ` (řádek ${err.line})` : ""}`);
        this.finish(slot.index);
      });
  }

  finish(index) {
    this.jobs.delete(index);
    this.emit();
    if (!this.jobs.size && typeof this.onIdle === "function") {
      this.onIdle();
    }
  }

  stop() {
    if (!this.jobs.size) {
      return;
    }
    this.jobs.forEach((job) => {
      job.stopped = true;
      if (job.vm) {
        job.vm.stop();
      }
    });
    this.jobs.clear();
    this.emit();
  }
}

module.exports = { MacroRunner };
