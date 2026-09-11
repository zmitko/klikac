class AppLog {
  constructor({ onChange, limit = 500 }) {
    this.onChange = onChange;
    this.limit = limit;
    this.lines = [];
  }

  clear() {
    this.lines = [];
    if (typeof this.onChange === "function") {
      this.onChange();
    }
  }

  push(source, message) {
    const text = String(message || "").trim();
    if (!text) {
      return;
    }
    const time = new Date().toLocaleTimeString("cs-CZ", { hour12: false });
    this.lines.push(`${time} [${source}] ${text}`);
    if (this.lines.length > this.limit) {
      this.lines = this.lines.slice(-this.limit);
    }
    if (typeof this.onChange === "function") {
      this.onChange();
    }
  }

  snapshot() {
    return this.lines.slice();
  }
}

module.exports = { AppLog };
