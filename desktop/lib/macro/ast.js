// Interní model makra (AST) + katalog konstrukcí.
// Katalog čte parser (klíčová slova), editor (formuláře), nápověda i validátor,
// takže nová konstrukce se přidává na jednom místě.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({ keymap: require("./keymap") });
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.ast = factory(root.KlikacMacro);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (dep) {
  const keymap = dep.keymap;

  const LANG_VERSION = "2.0";
  const MACRO_TYPE = { SIMPLE: "SIMPLE", COMPLEX: "COMPLEX" };

  let idSeq = 0;
  function nid() {
    idSeq += 1;
    return `n${idSeq}`;
  }

  function node(kind, props) {
    return { kind, id: nid(), line: 0, ...props };
  }

  // ---------- příkazy ----------
  const program = (body, macros) => node("Program", { body: body || [], macros: macros || [] });
  const macroDef = (name, params, body) => node("MacroDef", { name: name || "M1", params: params || [], body: body || [] });
  const press = (key) => node("Press", { key: key || "F1" });
  const waitFixed = (ms) => node("Wait", { mode: "fixed", ms: ms == null ? 1000 : ms });
  const waitRandom = (minMs, maxMs) => node("Wait", { mode: "random", minMs: minMs == null ? 2000 : minMs, maxMs: maxMs == null ? 5000 : maxMs });
  const waitUntil = (time) => node("Wait", { mode: "until", time: time || "18:00" });
  const repeat = (count, body) => node("Repeat", { count: count || num(5), body: body || [] });
  const forever = (body) => node("Forever", { body: body || [] });
  const during = (ms, body) => node("During", { ms: ms == null ? 30000 : ms, body: body || [] });
  const every = (ms, body) => node("Every", { ms: ms == null ? 10000 : ms, body: body || [] });
  const ifStmt = (cond, body, elseBody) => node("If", {
    cond: cond || binary(">=", varRef("POCET"), num(5)),
    body: body || [],
    elseBody: elseBody || null,
  });
  const setVar = (name, value) => node("Set", { name: name || "X", value: value || num(0) });
  const incVar = (name, by) => node("Inc", { name: name || "X", by: by || num(1) });
  const decVar = (name, by) => node("Dec", { name: name || "X", by: by || num(1) });
  const choice = (branches) => node("Choice", { branches: branches || [choiceBranch(), choiceBranch()] });
  const choiceBranch = (body, weight) => ({ id: nid(), weight: weight == null ? null : weight, body: body || [] });
  const call = (name, args) => node("Call", { name: name || "M1", args: args || [] });
  const breakStmt = () => node("Break", {});
  const continueStmt = () => node("Continue", {});
  const stopStmt = () => node("Stop", {});
  const print = (value) => node("Print", { value: value || str("ahoj") });
  const comment = (text) => node("Comment", { text: text || "" });

  // ---------- výrazy ----------
  const num = (value) => ({ kind: "Num", value: Number(value) || 0 });
  const str = (value) => ({ kind: "Str", value: String(value == null ? "" : value) });
  const varRef = (name) => ({ kind: "Var", name: String(name || "X").toUpperCase() });
  const now = () => ({ kind: "Now" });
  const clock = () => ({ kind: "Clock" });
  const timeLit = (minutes) => ({ kind: "TimeLit", minutes: Number(minutes) || 0 });
  const elapsed = (name) => ({ kind: "Elapsed", name: String(name || "START").toUpperCase() });
  const randRange = (min, max) => ({ kind: "RandRange", min: Number(min) || 0, max: Number(max) || 0 });
  const duration = (ms) => ({ kind: "Duration", ms: Number(ms) || 0 });
  const binary = (op, left, right) => ({ kind: "Binary", op, left, right });
  const unary = (op, expr) => ({ kind: "Unary", op, expr });

  const COMPARE_OPS = ["=", "!=", ">", "<", ">=", "<="];
  const LOGIC_OPS = ["A", "NEBO"];

  // ---------- čas ----------
  const UNITS = [
    { unit: "ms", ms: 1 },
    { unit: "s", ms: 1000 },
    { unit: "min", ms: 60000 },
    { unit: "h", ms: 3600000 },
  ];

  function unitMs(unit) {
    const found = UNITS.find((u) => u.unit === String(unit || "").toLowerCase());
    return found ? found.ms : 0;
  }

  function msToText(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    if (value === 0) {
      return "0ms";
    }
    if (value % 3600000 === 0) {
      return `${value / 3600000}h`;
    }
    if (value % 60000 === 0) {
      return `${value / 60000}min`;
    }
    if (value % 1000 === 0) {
      return `${value / 1000}s`;
    }
    return `${value}ms`;
  }

  function msToParts(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    for (let i = UNITS.length - 1; i >= 0; i -= 1) {
      const u = UNITS[i];
      if (value !== 0 && value % u.ms === 0) {
        return { value: value / u.ms, unit: u.unit };
      }
    }
    return { value, unit: "ms" };
  }

  function minutesToTime(minutes) {
    const total = ((Math.round(Number(minutes) || 0)) % 1440 + 1440) % 1440;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function timeToMinutes(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
    if (!match) {
      return null;
    }
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) {
      return null;
    }
    return h * 60 + m;
  }

  // ---------- katalog konstrukcí ----------
  // group: nadpis v paletě, fields: formulář v editoru, bodies: vnořitelné bloky.
  const CONSTRUCTS = [
    {
      id: "press",
      kind: "Press",
      keyword: "STISK",
      label: "Stisk klávesy",
      icon: "⌨",
      group: "AKCE",
      create: () => press("F1"),
      fields: [{ key: "key", label: "Klávesa", type: "key" }],
      bodies: [],
    },
    {
      id: "wait",
      kind: "Wait",
      keyword: "CEKEJ",
      label: "Čekání",
      icon: "⏱",
      group: "ČAS",
      create: () => waitFixed(3000),
      fields: [
        {
          key: "mode",
          label: "Typ",
          type: "select",
          options: [
            { value: "fixed", label: "pevně" },
            { value: "random", label: "náhodně" },
            { value: "until", label: "do času" },
          ],
        },
        { key: "ms", label: "Doba", type: "duration", when: { mode: "fixed" } },
        { key: "minMs", label: "Od", type: "duration", when: { mode: "random" } },
        { key: "maxMs", label: "Do", type: "duration", when: { mode: "random" } },
        { key: "time", label: "Čas", type: "time", when: { mode: "until" } },
      ],
      bodies: [],
    },
    {
      id: "repeat",
      kind: "Repeat",
      keyword: "OPAKUJ",
      label: "Opakuj",
      icon: "🔁",
      group: "CYKLY",
      create: () => repeat(num(5), []),
      fields: [{ key: "count", label: "Počet", type: "expr", hint: "číslo nebo proměnná" }],
      bodies: [{ key: "body", label: "" }],
    },
    {
      id: "forever",
      kind: "Forever",
      keyword: "DOKOLA",
      label: "Dokola",
      icon: "♾",
      group: "CYKLY",
      create: () => forever([]),
      fields: [],
      bodies: [{ key: "body", label: "" }],
    },
    {
      id: "during",
      kind: "During",
      keyword: "PO DOBU",
      label: "Po dobu",
      icon: "⏳",
      group: "CYKLY",
      create: () => during(30000, []),
      fields: [{ key: "ms", label: "Doba", type: "duration" }],
      bodies: [{ key: "body", label: "" }],
    },
    {
      id: "every",
      kind: "Every",
      keyword: "KAZDYCH",
      label: "Každých",
      icon: "🔄",
      group: "CYKLY",
      create: () => every(10000, []),
      fields: [{ key: "ms", label: "Perioda", type: "duration" }],
      bodies: [{ key: "body", label: "" }],
    },
    {
      id: "if",
      kind: "If",
      keyword: "POKUD",
      label: "Podmínka",
      icon: "❓",
      group: "PODMÍNKY",
      create: () => ifStmt(binary(">=", varRef("POCET"), num(5)), []),
      fields: [{ key: "cond", label: "Podmínka", type: "condition" }],
      bodies: [{ key: "body", label: "" }, { key: "elseBody", label: "JINAK", optional: true }],
    },
    {
      id: "set",
      kind: "Set",
      keyword: "NASTAV",
      label: "Nastav proměnnou",
      icon: "🔢",
      group: "PROMĚNNÉ",
      create: () => setVar("POCET", num(0)),
      fields: [
        { key: "name", label: "Proměnná", type: "name" },
        { key: "value", label: "Hodnota", type: "expr", hint: "číslo, proměnná, TED, NAHODNE 1-100" },
      ],
      bodies: [],
    },
    {
      id: "inc",
      kind: "Inc",
      keyword: "ZVYS",
      label: "Zvyš",
      icon: "➕",
      group: "PROMĚNNÉ",
      create: () => incVar("POCET", num(1)),
      fields: [
        { key: "name", label: "Proměnná", type: "name" },
        { key: "by", label: "O", type: "expr" },
      ],
      bodies: [],
    },
    {
      id: "dec",
      kind: "Dec",
      keyword: "SNIZ",
      label: "Sniž",
      icon: "➖",
      group: "PROMĚNNÉ",
      create: () => decVar("POCET", num(1)),
      fields: [
        { key: "name", label: "Proměnná", type: "name" },
        { key: "by", label: "O", type: "expr" },
      ],
      bodies: [],
    },
    {
      id: "choice",
      kind: "Choice",
      keyword: "NAHODNE",
      label: "Náhoda",
      icon: "🎲",
      group: "NÁHODA",
      create: () => choice([choiceBranch([press("F1")]), choiceBranch([press("F2")])]),
      fields: [],
      bodies: [],
      branches: true,
    },
    {
      id: "call",
      kind: "Call",
      keyword: "SPUST",
      label: "Spusť makro",
      icon: "📦",
      group: "MAKRA",
      create: () => call("M1", []),
      fields: [
        { key: "name", label: "Makro", type: "macroName" },
        { key: "args", label: "Parametry", type: "args" },
      ],
      bodies: [],
    },
    {
      id: "macroDef",
      kind: "MacroDef",
      keyword: "MAKRO",
      label: "Definice makra",
      icon: "🧩",
      group: "MAKRA",
      create: () => macroDef("M1", [], []),
      fields: [
        { key: "name", label: "Název", type: "name" },
        { key: "params", label: "Parametry", type: "params" },
      ],
      bodies: [{ key: "body", label: "" }],
      topLevel: true,
    },
    {
      id: "break",
      kind: "Break",
      keyword: "BREAK",
      label: "Break",
      icon: "⏹",
      group: "ŘÍZENÍ",
      create: () => breakStmt(),
      fields: [],
      bodies: [],
    },
    {
      id: "continue",
      kind: "Continue",
      keyword: "CONTINUE",
      label: "Continue",
      icon: "▶",
      group: "ŘÍZENÍ",
      create: () => continueStmt(),
      fields: [],
      bodies: [],
    },
    {
      id: "stop",
      kind: "Stop",
      keyword: "STOP",
      label: "Stop",
      icon: "🛑",
      group: "ŘÍZENÍ",
      create: () => stopStmt(),
      fields: [],
      bodies: [],
    },
    {
      id: "print",
      kind: "Print",
      keyword: "VYPIS",
      label: "Výpis",
      icon: "🖊",
      group: "ŘÍZENÍ",
      create: () => print(str("Start makra")),
      fields: [{ key: "value", label: "Text / proměnná", type: "expr", hint: "\"text\" nebo název proměnné" }],
      bodies: [],
    },
    {
      id: "comment",
      kind: "Comment",
      keyword: "#",
      label: "Komentář",
      icon: "💬",
      group: "ŘÍZENÍ",
      create: () => comment("poznámka"),
      fields: [{ key: "text", label: "Text", type: "text" }],
      bodies: [],
    },
  ];

  const BY_ID = new Map(CONSTRUCTS.map((c) => [c.id, c]));
  const BY_KIND = new Map(CONSTRUCTS.map((c) => [c.kind, c]));

  const constructById = (id) => BY_ID.get(id) || null;
  const constructByKind = (kind) => BY_KIND.get(kind) || null;

  function constructGroups() {
    const groups = [];
    CONSTRUCTS.forEach((c) => {
      let group = groups.find((g) => g.label === c.group);
      if (!group) {
        group = { label: c.group, items: [] };
        groups.push(group);
      }
      group.items.push(c);
    });
    return groups;
  }

  const LOOP_KINDS = new Set(["Repeat", "Forever", "During", "Every"]);
  const isLoop = (n) => !!n && LOOP_KINDS.has(n.kind);

  // ---------- práce se stromem ----------
  // Vrací všechna místa, kam se dá vnořovat: { owner, key, list, label }.
  function childLists(n) {
    if (!n || typeof n !== "object") {
      return [];
    }
    if (n.kind === "Program") {
      return [
        { owner: n, key: "macros", list: n.macros, label: "Definice maker" },
        { owner: n, key: "body", list: n.body, label: "Program" },
      ];
    }
    if (n.kind === "Choice") {
      return (n.branches || []).map((branch, i) => ({
        owner: branch,
        key: "body",
        list: branch.body,
        label: i === 0 ? "NAHODNE" : "NEBO",
      }));
    }
    const spec = constructByKind(n.kind);
    if (!spec) {
      return [];
    }
    const out = [];
    spec.bodies.forEach((body) => {
      if (Array.isArray(n[body.key])) {
        out.push({ owner: n, key: body.key, list: n[body.key], label: body.label });
      }
    });
    return out;
  }

  function isContainer(n) {
    return childLists(n).length > 0;
  }

  function walk(n, fn, parent) {
    if (!n) {
      return;
    }
    if (fn(n, parent) === false) {
      return;
    }
    childLists(n).forEach((slot) => {
      slot.list.forEach((child) => walk(child, fn, n));
    });
  }

  function find(root2, id) {
    let hit = null;
    walk(root2, (n) => {
      if (n.id === id) {
        hit = n;
        return false;
      }
      return true;
    });
    return hit;
  }

  // { node, list, index, owner, key } nebo null
  function locate(root2, id) {
    let hit = null;
    const scan = (n) => {
      childLists(n).forEach((slot) => {
        slot.list.forEach((child, index) => {
          if (hit) {
            return;
          }
          if (child.id === id) {
            hit = { node: child, list: slot.list, index, owner: slot.owner, key: slot.key };
            return;
          }
          scan(child);
        });
      });
    };
    scan(root2);
    return hit;
  }

  function listByRef(root2, ownerId, key) {
    if (root2.id === ownerId) {
      return Array.isArray(root2[key]) ? root2[key] : null;
    }
    let hit = null;
    const scan = (n) => {
      childLists(n).forEach((slot) => {
        if (hit) {
          return;
        }
        if (slot.owner.id === ownerId && slot.key === key) {
          hit = slot.list;
          return;
        }
        slot.list.forEach((child) => scan(child));
      });
    };
    scan(root2);
    return hit;
  }

  function cloneNode(n) {
    const copy = JSON.parse(JSON.stringify(n));
    walk(copy, (x) => {
      x.id = nid();
      if (x.kind === "Choice") {
        (x.branches || []).forEach((b) => {
          b.id = nid();
        });
      }
      return true;
    });
    return copy;
  }

  function insertInto(root2, ownerId, key, newNode, index) {
    const list = listByRef(root2, ownerId, key);
    if (!list) {
      return false;
    }
    const at = index == null || index < 0 || index > list.length ? list.length : index;
    list.splice(at, 0, newNode);
    return true;
  }

  function insertAfter(root2, id, newNode) {
    const found = locate(root2, id);
    if (!found) {
      return false;
    }
    found.list.splice(found.index + 1, 0, newNode);
    return true;
  }

  function removeNode(root2, id) {
    const found = locate(root2, id);
    if (!found) {
      return null;
    }
    found.list.splice(found.index, 1);
    return found.node;
  }

  function duplicateNode(root2, id) {
    const found = locate(root2, id);
    if (!found) {
      return null;
    }
    const copy = cloneNode(found.node);
    found.list.splice(found.index + 1, 0, copy);
    return copy;
  }

  function moveNode(root2, id, dir) {
    const found = locate(root2, id);
    if (!found) {
      return false;
    }
    const target = found.index + (dir < 0 ? -1 : 1);
    if (target < 0 || target >= found.list.length) {
      return false;
    }
    const [item] = found.list.splice(found.index, 1);
    found.list.splice(target, 0, item);
    return true;
  }

  // Zanoření: přesune uzel do těla předchozího sourozence (když to jde).
  function nestNode(root2, id) {
    const found = locate(root2, id);
    if (!found || found.index === 0) {
      return false;
    }
    const prev = found.list[found.index - 1];
    const slots = childLists(prev);
    if (!slots.length) {
      return false;
    }
    const [item] = found.list.splice(found.index, 1);
    slots[0].list.push(item);
    return true;
  }

  // Vysunutí: přesune uzel za jeho vlastníka.
  function outdentNode(root2, id) {
    const found = locate(root2, id);
    if (!found) {
      return false;
    }
    const ownerId = found.owner.id;
    const ownerLoc = root2.id === ownerId ? null : locate(root2, ownerId);
    if (!ownerLoc) {
      // vlastník je Program nebo NAHODNE větev na nejvyšší úrovni
      const branchOwner = findChoiceOfBranch(root2, ownerId);
      if (!branchOwner) {
        return false;
      }
      const choiceLoc = locate(root2, branchOwner.id);
      if (!choiceLoc) {
        return false;
      }
      const [item] = found.list.splice(found.index, 1);
      choiceLoc.list.splice(choiceLoc.index + 1, 0, item);
      return true;
    }
    const [item] = found.list.splice(found.index, 1);
    ownerLoc.list.splice(ownerLoc.index + 1, 0, item);
    return true;
  }

  function findChoiceOfBranch(root2, branchId) {
    let hit = null;
    walk(root2, (n) => {
      if (n.kind === "Choice" && (n.branches || []).some((b) => b.id === branchId)) {
        hit = n;
        return false;
      }
      return true;
    });
    return hit;
  }

  function newProgram() {
    return program([], []);
  }

  function isEmptyProgram(prog) {
    return !prog || ((prog.body || []).length === 0 && (prog.macros || []).length === 0);
  }

  return {
    LANG_VERSION,
    MACRO_TYPE,
    COMPARE_OPS,
    LOGIC_OPS,
    UNITS,
    CONSTRUCTS,
    nid,
    program,
    macroDef,
    press,
    waitFixed,
    waitRandom,
    waitUntil,
    repeat,
    forever,
    during,
    every,
    ifStmt,
    setVar,
    incVar,
    decVar,
    choice,
    choiceBranch,
    call,
    breakStmt,
    continueStmt,
    stopStmt,
    print,
    comment,
    num,
    str,
    varRef,
    now,
    clock,
    timeLit,
    elapsed,
    randRange,
    duration,
    binary,
    unary,
    unitMs,
    msToText,
    msToParts,
    minutesToTime,
    timeToMinutes,
    constructById,
    constructByKind,
    constructGroups,
    isLoop,
    isContainer,
    childLists,
    walk,
    find,
    locate,
    listByRef,
    cloneNode,
    insertInto,
    insertAfter,
    removeNode,
    duplicateNode,
    moveNode,
    nestNode,
    outdentNode,
    newProgram,
    isEmptyProgram,
    keys: keymap,
  };
});
