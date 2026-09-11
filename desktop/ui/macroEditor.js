// Editor komplexního makra. Pracuje nad AST (ne nad textem) — text se z AST
// generuje pro režim KÓD a pro uložení do stavu aplikace.
(function () {
  const M = window.KlikacMacro;
  const { ast, parser, serialize, validator, simpleParser, help, keymap } = M;
  const TYPE = ast.MACRO_TYPE;

  const $ = (id) => document.getElementById(id);

  const state = {
    open: false,
    index: 0,
    name: "",
    type: TYPE.SIMPLE,
    seq: "",
    program: "",
    ast: null,
    mode: "visual",
    codeText: "",
    codeDirty: false,
    selection: null,
    target: null,
    helpId: "",
    validation: null,
    byLine: new Map(),
    maximized: false,
  };

  let hooks = { onSave: () => {}, onToast: () => {} };

  // ---------- pomůcky ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text != null) {
      node.textContent = text;
    }
    return node;
  }

  // 1 chyba / 2–4 chyby / 5+ chyb
  function plural(count, one, few, many) {
    if (count === 1) {
      return one;
    }
    return count >= 2 && count <= 4 ? few : many;
  }

  function button(className, text, dataset, title) {
    const node = el("button", className, text);
    node.type = "button";
    Object.entries(dataset || {}).forEach(([key, value]) => {
      node.dataset[key] = value;
    });
    if (title) {
      node.title = title;
    }
    return node;
  }

  function macroNames() {
    return ((state.ast && state.ast.macros) || []).map((macro) => macro.name);
  }

  function syncText() {
    const annotated = serialize.annotate(state.ast);
    state.program = annotated.text;
    state.byLine = annotated.byLine;
    return annotated.text;
  }

  function save() {
    hooks.onSave({
      index: state.index,
      name: state.name,
      type: state.type,
      seq: state.seq,
      program: state.program,
    });
  }

  function touched() {
    if (state.type === TYPE.COMPLEX && state.mode === "visual") {
      syncText();
    }
    state.validation = null;
    save();
  }

  // ---------- paleta ----------
  function renderPalette() {
    const root = $("macro-palette");
    root.textContent = "";
    ast.constructGroups().forEach((group) => {
      root.appendChild(el("div", "pal-group", group.label));
      const wrap = el("div", "pal-items");
      group.items.forEach((item) => {
        const btn = button("pal-item", "", { construct: item.id }, item.label);
        btn.appendChild(el("span", "pal-ico", item.icon));
        btn.appendChild(el("span", "pal-label", item.label));
        btn.appendChild(el("span", "pal-kw", item.keyword));
        if (state.helpId === item.id) {
          btn.classList.add("is-active");
        }
        wrap.appendChild(btn);
      });
      root.appendChild(wrap);
    });
  }

  function renderHelp() {
    const root = $("macro-help");
    const entry = help.helpFor(state.helpId);
    root.textContent = "";
    root.appendChild(el("div", "help-title", `${entry.icon ? `${entry.icon} ` : ""}${entry.title}`));
    root.appendChild(el("p", "help-sum", entry.summary));
    if (entry.when) {
      root.appendChild(el("div", "help-lbl", "Kdy použít"));
      root.appendChild(el("p", "help-txt", entry.when));
    }
    if (entry.syntax) {
      root.appendChild(el("div", "help-lbl", "Syntaxe"));
      root.appendChild(el("pre", "help-code", entry.syntax));
    }
    if (entry.example) {
      root.appendChild(el("div", "help-lbl", "Příklad"));
      root.appendChild(el("pre", "help-code", entry.example));
    }
    if (entry.params) {
      root.appendChild(el("div", "help-lbl", "Parametr"));
      root.appendChild(el("p", "help-txt", entry.params));
    }
    if (entry.limits) {
      root.appendChild(el("div", "help-lbl", "Omezení"));
      root.appendChild(el("p", "help-txt", entry.limits));
    }
  }

  // ---------- formulářová pole konstrukcí ----------
  function fieldVisible(field, node) {
    if (!field.when) {
      return true;
    }
    return Object.entries(field.when).every(([key, value]) => node[key] === value);
  }

  function makeInput(node, field, value, extraClass) {
    const input = el("input", `blk-input ${extraClass || ""}`.trim());
    input.type = "text";
    input.value = value == null ? "" : String(value);
    input.dataset.id = node.id;
    input.dataset.field = field.key;
    if (field.hint) {
      input.title = field.hint;
      input.placeholder = field.hint;
    }
    return input;
  }

  function renderField(node, field, wrap) {
    if (!fieldVisible(field, node)) {
      return;
    }
    const label = el("label", "blk-field");
    if (field.label) {
      label.appendChild(el("span", "blk-flabel", field.label));
    }
    switch (field.type) {
      case "key": {
        const select = el("select", "blk-input");
        select.dataset.id = node.id;
        select.dataset.field = field.key;
        const current = keymap.normalizeKey(node[field.key]) || node[field.key];
        keymap.supportedList().forEach((key) => {
          const option = el("option", "", key);
          option.value = key;
          if (key === current) {
            option.selected = true;
          }
          select.appendChild(option);
        });
        if (!keymap.supportedList().includes(current)) {
          const option = el("option", "", `${node[field.key]} (neznámá)`);
          option.value = node[field.key];
          option.selected = true;
          select.appendChild(option);
        }
        label.appendChild(select);
        break;
      }
      case "select": {
        const select = el("select", "blk-input");
        select.dataset.id = node.id;
        select.dataset.field = field.key;
        (field.options || []).forEach((opt) => {
          const option = el("option", "", opt.label);
          option.value = opt.value;
          if (opt.value === node[field.key]) {
            option.selected = true;
          }
          select.appendChild(option);
        });
        label.appendChild(select);
        break;
      }
      case "duration": {
        const parts = ast.msToParts(node[field.key]);
        const number = el("input", "blk-input num");
        number.type = "number";
        number.min = "1";
        number.value = String(parts.value);
        number.dataset.id = node.id;
        number.dataset.field = field.key;
        number.dataset.part = "value";
        const select = el("select", "blk-input unit");
        select.dataset.id = node.id;
        select.dataset.field = field.key;
        select.dataset.part = "unit";
        ast.UNITS.forEach((unit) => {
          const option = el("option", "", unit.unit);
          option.value = unit.unit;
          if (unit.unit === parts.unit) {
            option.selected = true;
          }
          select.appendChild(option);
        });
        label.appendChild(number);
        label.appendChild(select);
        break;
      }
      case "time":
        label.appendChild(makeInput(node, field, node[field.key], "time"));
        break;
      case "name":
        label.appendChild(makeInput(node, field, node[field.key], "name"));
        break;
      case "text":
        label.appendChild(makeInput(node, field, node[field.key], "text"));
        break;
      case "expr":
        label.appendChild(makeInput(node, field, serialize.exprToText(node[field.key]), "expr"));
        break;
      case "args":
        label.appendChild(makeInput(node, field, (node.args || []).map(serialize.exprToText).join(", "), "expr"));
        break;
      case "params":
        label.appendChild(makeInput(node, field, (node.params || []).join(", "), "expr"));
        break;
      case "macroName": {
        const names = macroNames();
        if (names.length) {
          const select = el("select", "blk-input");
          select.dataset.id = node.id;
          select.dataset.field = field.key;
          const all = names.includes(node.name) ? names : [node.name, ...names];
          all.forEach((name) => {
            const option = el("option", "", name);
            option.value = name;
            if (name === node.name) {
              option.selected = true;
            }
            select.appendChild(option);
          });
          label.appendChild(select);
        } else {
          label.appendChild(makeInput(node, field, node.name, "name"));
        }
        break;
      }
      case "condition":
        renderCondition(node, field, label);
        break;
      default:
        label.appendChild(makeInput(node, field, node[field.key]));
        break;
    }
    wrap.appendChild(label);
  }

  function isSimpleComparison(expr) {
    return !!expr
      && expr.kind === "Binary"
      && ast.COMPARE_OPS.includes(expr.op)
      && expr.left && expr.right
      && expr.left.kind !== "Binary" && expr.right.kind !== "Binary";
  }

  function renderCondition(node, field, label) {
    const expr = node[field.key];
    if (node.condRaw || !isSimpleComparison(expr)) {
      const input = makeInput(node, field, serialize.exprToText(expr), "cond-raw");
      input.placeholder = "např. POCET >= 5 A POCET < 10";
      label.appendChild(input);
      label.appendChild(button("blk-mini", "⇄", { id: node.id, act: "cond-simple" }, "Zkusit jednoduchý tvar"));
      return;
    }
    const left = makeInput(node, field, serialize.exprToText(expr.left), "cond-part");
    left.dataset.part = "left";
    const op = el("select", "blk-input op");
    op.dataset.id = node.id;
    op.dataset.field = field.key;
    op.dataset.part = "op";
    ast.COMPARE_OPS.forEach((candidate) => {
      const option = el("option", "", candidate);
      option.value = candidate;
      if (candidate === expr.op) {
        option.selected = true;
      }
      op.appendChild(option);
    });
    const right = makeInput(node, field, serialize.exprToText(expr.right), "cond-part");
    right.dataset.part = "right";
    label.appendChild(left);
    label.appendChild(op);
    label.appendChild(right);
    label.appendChild(button("blk-mini", "fx", { id: node.id, act: "cond-raw" }, "Zapsat výrazem"));
  }

  // ---------- bloky ----------
  function renderTools(node, wrap) {
    const tools = el("div", "blk-tools");
    tools.appendChild(button("blk-tool", "↑", { id: node.id, act: "up" }, "Nahoru"));
    tools.appendChild(button("blk-tool", "↓", { id: node.id, act: "down" }, "Dolů"));
    tools.appendChild(button("blk-tool", "⇥", { id: node.id, act: "nest" }, "Zanořit do bloku nad"));
    tools.appendChild(button("blk-tool", "⇤", { id: node.id, act: "outdent" }, "Vysunout z bloku"));
    tools.appendChild(button("blk-tool", "⧉", { id: node.id, act: "dup" }, "Duplikovat"));
    tools.appendChild(button("blk-tool danger", "🗑", { id: node.id, act: "del" }, "Odstranit"));
    wrap.appendChild(tools);
  }

  function renderBodySlot(ownerId, key, list, label, into) {
    const body = el("div", "blk-body");
    body.dataset.owner = ownerId;
    body.dataset.key = key;
    if (label) {
      body.appendChild(el("div", "blk-body-label", label));
    }
    (list || []).forEach((child) => body.appendChild(renderNode(child)));
    const add = button("blk-add", "Přidejte konstrukci", { owner: ownerId, key });
    if (state.target && state.target.ownerId === ownerId && state.target.key === key) {
      add.classList.add("is-target");
      add.textContent = "▸ sem se vloží konstrukce";
    }
    body.appendChild(add);
    into.appendChild(body);
  }

  function renderNode(node) {
    const spec = ast.constructByKind(node.kind);
    const wrap = el("div", "blk");
    wrap.dataset.id = node.id;
    wrap.dataset.kind = node.kind;
    if (state.selection === node.id) {
      wrap.classList.add("is-selected");
    }
    if (ast.isContainer(node)) {
      wrap.classList.add("is-block");
    }
    if (node.kind === "Comment") {
      wrap.classList.add("is-comment");
    }

    const head = el("div", "blk-head");
    head.appendChild(el("span", "blk-ico", spec ? spec.icon : "•"));
    head.appendChild(el("span", "blk-kw", spec ? spec.keyword : node.kind));
    const fields = el("div", "blk-fields");
    (spec ? spec.fields : []).forEach((field) => renderField(node, field, fields));
    head.appendChild(fields);
    renderTools(node, head);
    wrap.appendChild(head);

    if (node.kind === "Choice") {
      const branches = el("div", "blk-branches");
      (node.branches || []).forEach((branch, index) => {
        const row = el("div", "blk-branch");
        const bhead = el("div", "blk-branch-head");
        bhead.appendChild(el("span", "blk-branch-kw", index === 0 ? "NAHODNE" : "NEBO"));
        const weight = el("input", "blk-input num");
        weight.type = "number";
        weight.min = "0";
        weight.max = "100";
        weight.placeholder = "%";
        weight.value = branch.weight == null ? "" : String(branch.weight);
        weight.dataset.branch = branch.id;
        weight.dataset.field = "weight";
        weight.title = "Váha v procentech (nechej prázdné pro rovnoměrnou náhodu)";
        bhead.appendChild(weight);
        bhead.appendChild(el("span", "blk-flabel", "%"));
        bhead.appendChild(button("blk-tool danger", "🗑", { id: node.id, branch: branch.id, act: "branch-del" }, "Odstranit variantu"));
        row.appendChild(bhead);
        renderBodySlot(branch.id, "body", branch.body, "", row);
        branches.appendChild(row);
      });
      branches.appendChild(button("blk-add ghost", "+ varianta", { id: node.id, act: "branch-add" }));
      wrap.appendChild(branches);
      return wrap;
    }

    (spec ? spec.bodies : []).forEach((body) => {
      if (body.optional && !Array.isArray(node[body.key])) {
        wrap.appendChild(button("blk-add ghost", `+ ${body.label || body.key}`, { id: node.id, act: "add-else", key: body.key }));
        return;
      }
      if (!Array.isArray(node[body.key])) {
        return;
      }
      if (body.optional) {
        const bar = el("div", "blk-else-bar");
        bar.appendChild(el("span", "blk-branch-kw", body.label));
        bar.appendChild(button("blk-tool danger", "🗑", { id: node.id, act: "del-else", key: body.key }, "Zrušit JINAK"));
        wrap.appendChild(bar);
        renderBodySlot(node.id, body.key, node[body.key], "", wrap);
        return;
      }
      renderBodySlot(node.id, body.key, node[body.key], body.label, wrap);
    });
    return wrap;
  }

  function renderVisual() {
    const root = $("macro-visual");
    const focus = captureFocus();
    root.textContent = "";
    if (!state.ast) {
      state.ast = ast.newProgram();
    }
    const macros = el("section", "prog-section");
    macros.appendChild(el("div", "prog-head", "DEFINICE MAKER"));
    renderBodySlot(state.ast.id, "macros", state.ast.macros, "", macros);
    root.appendChild(macros);

    const body = el("section", "prog-section");
    body.appendChild(el("div", "prog-head", "PROGRAM"));
    renderBodySlot(state.ast.id, "body", state.ast.body, "", body);
    root.appendChild(body);
    restoreFocus(focus);
  }

  // Výběr bloku mění jen zvýraznění, takže se strom nepřekresluje — překreslení
  // by zavřelo rozbalený <select>, na který se právě kliklo.
  function paintSelection() {
    const root = $("macro-visual");
    root.querySelectorAll(".blk").forEach((blk) => {
      blk.classList.toggle("is-selected", blk.dataset.id === state.selection);
    });
    root.querySelectorAll(".blk-add[data-owner]").forEach((add) => {
      const active =
        Boolean(state.target) &&
        add.dataset.owner === state.target.ownerId &&
        add.dataset.key === state.target.key;
      add.classList.toggle("is-target", active);
      add.textContent = active ? "▸ sem se vloží konstrukce" : "Přidejte konstrukci";
    });
    renderPalette();
    renderHelp();
  }

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !active.dataset || (!active.dataset.id && !active.dataset.branch)) {
      return null;
    }
    return {
      id: active.dataset.id || "",
      branch: active.dataset.branch || "",
      field: active.dataset.field || "",
      part: active.dataset.part || "",
      start: typeof active.selectionStart === "number" ? active.selectionStart : null,
    };
  }

  function restoreFocus(focus) {
    if (!focus) {
      return;
    }
    const scope = focus.branch ? `[data-branch="${focus.branch}"]` : `[data-id="${focus.id}"]`;
    const selector = `${scope}[data-field="${focus.field}"]${focus.part ? `[data-part="${focus.part}"]` : ""}`;
    const target = $("macro-visual").querySelector(selector);
    if (!target) {
      return;
    }
    target.focus();
    if (focus.start != null && typeof target.setSelectionRange === "function") {
      try {
        target.setSelectionRange(focus.start, focus.start);
      } catch {
        /* number input selection není všude povolená */
      }
    }
  }

  // ---------- vkládání a úpravy ----------
  function insertConstruct(constructId) {
    const spec = ast.constructById(constructId);
    if (!spec) {
      return;
    }
    const node = spec.create();
    if (spec.topLevel) {
      state.ast.macros.push(node);
    } else if (state.target && ast.insertInto(state.ast, state.target.ownerId, state.target.key, node)) {
      // vloženo do vybraného místa
    } else if (state.selection && ast.find(state.ast, state.selection)) {
      const selected = ast.find(state.ast, state.selection);
      const slots = ast.childLists(selected);
      if (slots.length) {
        slots[0].list.push(node);
      } else {
        ast.insertAfter(state.ast, state.selection, node);
      }
    } else {
      state.ast.body.push(node);
    }
    state.selection = node.id;
    state.helpId = constructId;
    if (ast.isContainer(node)) {
      const slots = ast.childLists(node);
      state.target = slots.length ? { ownerId: slots[0].owner.id, key: slots[0].key } : null;
    }
    touched();
    render();
  }

  function nodeAction(id, act, extra) {
    const node = ast.find(state.ast, id);
    if (!node) {
      return;
    }
    switch (act) {
      case "up":
        ast.moveNode(state.ast, id, -1);
        break;
      case "down":
        ast.moveNode(state.ast, id, 1);
        break;
      case "nest":
        if (!ast.nestNode(state.ast, id)) {
          hooks.onToast("Nad konstrukcí musí být blok, do kterého se dá zanořit.");
          return;
        }
        break;
      case "outdent":
        if (!ast.outdentNode(state.ast, id)) {
          hooks.onToast("Konstrukce už je na nejvyšší úrovni.");
          return;
        }
        break;
      case "dup": {
        const copy = ast.duplicateNode(state.ast, id);
        if (copy) {
          state.selection = copy.id;
        }
        break;
      }
      case "del":
        ast.removeNode(state.ast, id);
        if (state.selection === id) {
          state.selection = null;
        }
        break;
      case "add-else":
        node.elseBody = [];
        break;
      case "del-else":
        node.elseBody = null;
        break;
      case "branch-add":
        node.branches.push(ast.choiceBranch([], null));
        break;
      case "branch-del":
        if (node.branches.length <= 1) {
          hooks.onToast("NAHODNE musí mít aspoň jednu variantu.");
          return;
        }
        node.branches = node.branches.filter((branch) => branch.id !== extra);
        break;
      case "cond-raw":
        node.condRaw = true;
        break;
      case "cond-simple":
        node.condRaw = false;
        break;
      default:
        return;
    }
    touched();
    render();
  }

  function setExprField(node, key, text, label) {
    const parsed = parser.parseExpressionText(text, label);
    if (!parsed.expr || parsed.errors.length) {
      return parsed.errors[0] ? parsed.errors[0].message : `${label}: nerozumím zápisu.`;
    }
    node[key] = parsed.expr;
    return null;
  }

  function applyFieldChange(target) {
    const id = target.dataset.id;
    const branchId = target.dataset.branch;
    const field = target.dataset.field;
    const part = target.dataset.part || "";
    const raw = target.value;

    if (branchId) {
      let hit = null;
      ast.walk(state.ast, (node) => {
        if (node.kind === "Choice") {
          const branch = (node.branches || []).find((b) => b.id === branchId);
          if (branch) {
            hit = branch;
            return false;
          }
        }
        return true;
      });
      if (hit) {
        const text = String(raw).trim();
        hit.weight = text === "" ? null : Math.max(0, Math.min(100, Number(text) || 0));
        touched();
      }
      return null;
    }

    const node = ast.find(state.ast, id);
    if (!node) {
      return null;
    }
    const spec = ast.constructByKind(node.kind);
    const fieldSpec = (spec ? spec.fields : []).find((f) => f.key === field);
    if (!fieldSpec) {
      return null;
    }

    let error = null;
    switch (fieldSpec.type) {
      case "key":
        node.key = raw;
        delete node.raw;
        break;
      case "select":
        node[field] = raw;
        if (node.kind === "Wait") {
          normalizeWait(node);
        }
        break;
      case "duration": {
        const parts = ast.msToParts(node[field]);
        const value = part === "value" ? Number(raw) : parts.value;
        const unit = part === "unit" ? raw : parts.unit;
        const ms = Math.max(0, Math.round((Number(value) || 0) * ast.unitMs(unit)));
        node[field] = ms;
        if (ms <= 0) {
          error = "Doba musí být větší než 0.";
        }
        break;
      }
      case "time": {
        node[field] = String(raw).trim();
        if (ast.timeToMinutes(node[field]) == null) {
          error = "Čas musí být ve tvaru HH:MM.";
        }
        break;
      }
      case "name": {
        const name = String(raw).trim().toUpperCase();
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) {
          error = "Název smí obsahovat jen písmena, číslice a podtržítko.";
          break;
        }
        node[field] = name;
        break;
      }
      case "macroName":
        node.name = String(raw).trim().toUpperCase();
        break;
      case "text":
        node[field] = String(raw);
        break;
      case "expr":
        error = setExprField(node, field, raw, fieldSpec.label || "Výraz");
        break;
      case "args": {
        const text = String(raw).trim();
        if (!text) {
          node.args = [];
          break;
        }
        const args = [];
        for (const piece of text.split(",")) {
          const parsed = parser.parseExpressionText(piece, "Parametr");
          if (!parsed.expr || parsed.errors.length) {
            error = parsed.errors[0] ? parsed.errors[0].message : "Parametry: nerozumím zápisu.";
            break;
          }
          args.push(parsed.expr);
        }
        if (!error) {
          node.args = args;
        }
        break;
      }
      case "params": {
        const text = String(raw).trim();
        const names = text ? text.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean) : [];
        const bad = names.find((name) => !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name));
        if (bad) {
          error = `Parametr „${bad}“ není platný název.`;
          break;
        }
        node.params = names;
        break;
      }
      case "condition": {
        if (part === "left" || part === "right" || part === "op") {
          const cond = node[field];
          if (!isSimpleComparison(cond)) {
            error = setExprField(node, field, raw, "Podmínka");
            break;
          }
          if (part === "op") {
            cond.op = raw;
            break;
          }
          const parsed = parser.parseExpressionText(raw, "Podmínka");
          if (!parsed.expr || parsed.errors.length) {
            error = parsed.errors[0] ? parsed.errors[0].message : "Podmínka: nerozumím zápisu.";
            break;
          }
          cond[part] = parsed.expr;
          break;
        }
        error = setExprField(node, field, raw, "Podmínka");
        break;
      }
      default:
        node[field] = raw;
        break;
    }

    target.classList.toggle("is-bad", !!error);
    target.title = error || (fieldSpec.hint || "");
    if (!error) {
      touched();
    }
    return error;
  }

  function normalizeWait(node) {
    if (node.mode === "fixed") {
      if (!Number.isFinite(node.ms) || node.ms <= 0) {
        // při přepnutí z náhodného čekání ať zůstane aspoň dolní hranice
        node.ms = Number.isFinite(node.minMs) && node.minMs > 0 ? node.minMs : 3000;
      }
      delete node.seconds;
    } else if (node.mode === "random") {
      if (!Number.isFinite(node.minMs) || node.minMs <= 0) {
        node.minMs = 2000;
      }
      if (!Number.isFinite(node.maxMs) || node.maxMs <= node.minMs) {
        node.maxMs = node.minMs + 3000;
      }
    } else if (node.mode === "until") {
      if (ast.timeToMinutes(node.time) == null) {
        node.time = "18:00";
      }
    }
  }

  // ---------- validace ----------
  function runValidation(silent) {
    if (state.type === TYPE.SIMPLE) {
      const result = validator.validateSimple(state.seq, { loop: true });
      state.validation = result;
      renderStatus();
      return result;
    }
    if (state.mode === "code") {
      const result = validator.validateText($("macro-code").value);
      state.validation = result;
      renderStatus();
      return result;
    }
    syncText();
    const result = validator.validateProgram(state.ast, []);
    state.validation = result;
    renderStatus();
    if (!silent && result.ok) {
      hooks.onToast("Makro je validní a lze jej zkompilovat");
    }
    return result;
  }

  function renderStatus() {
    const statusEl = $("macro-status");
    const issuesEl = $("macro-issues");
    issuesEl.textContent = "";
    const result = state.validation;
    if (!result) {
      statusEl.className = "macro-status";
      statusEl.textContent = "Stav: nevalidováno";
      return;
    }
    if (result.ok) {
      statusEl.className = "macro-status is-ok";
      statusEl.textContent = "✓ Validace dokončena — makro je připraveno ke spuštění";
      const list = el("ul", "issue-list ok");
      result.levels.forEach((level) => {
        list.appendChild(el("li", "issue ok", `✓ ${level.label}`));
      });
      if (result.device) {
        list.appendChild(el("li", "issue ok", `✓ Sekvence jde poslat i přímo destičce: ${result.device}`));
      }
      result.warnings.forEach((warn) => {
        const item = el("li", "issue warn", `⚠ ${warn.message}${warn.line ? ` (řádek ${warn.line})` : ""}`);
        if (warn.line) {
          item.dataset.line = warn.line;
        }
        list.appendChild(item);
      });
      issuesEl.appendChild(list);
      return;
    }
    statusEl.className = "macro-status is-bad";
    statusEl.textContent = `❌ Makro obsahuje ${result.errors.length} ${plural(result.errors.length, "chybu", "chyby", "chyb")} — spustit ho nejde`;
    const list = el("ul", "issue-list");
    result.levels.forEach((level) => {
      list.appendChild(el("li", `issue ${level.ok ? "ok" : "bad"}`, `${level.ok ? "✓" : "✗"} ${level.label}`));
    });
    result.errors.forEach((err) => {
      const item = el("li", "issue bad clickable", `${err.line ? `Řádek ${err.line}: ` : ""}${err.message}`);
      if (err.line) {
        item.dataset.line = err.line;
      }
      list.appendChild(item);
    });
    result.warnings.forEach((warn) => {
      const item = el("li", "issue warn", `⚠ ${warn.message}${warn.line ? ` (řádek ${warn.line})` : ""}`);
      if (warn.line) {
        item.dataset.line = warn.line;
      }
      list.appendChild(item);
    });
    issuesEl.appendChild(list);
  }

  function gotoLine(line) {
    if (!line) {
      return;
    }
    if (state.mode === "code" || state.type === TYPE.SIMPLE) {
      const area = $("macro-code");
      if (state.type === TYPE.SIMPLE) {
        $("macro-simple-seq").focus();
        return;
      }
      const lines = area.value.split("\n");
      let start = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i += 1) {
        start += lines[i].length + 1;
      }
      const end = start + (lines[line - 1] || "").length;
      area.focus();
      area.setSelectionRange(start, end);
      return;
    }
    const id = state.byLine.get(line);
    if (!id) {
      return;
    }
    state.selection = id;
    const node = ast.find(state.ast, id);
    if (node) {
      state.helpId = (ast.constructByKind(node.kind) || {}).id || "";
    }
    render();
    const target = $("macro-visual").querySelector(`[data-id="${id}"]`);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // ---------- režimy ----------
  function setMode(mode) {
    if (mode === state.mode) {
      return;
    }
    if (mode === "code") {
      state.mode = "code";
      state.codeText = syncText();
      render();
      return;
    }
    // KÓD -> VIZUÁLNĚ: text musí projít parserem, jinak si necháme platný AST
    const text = $("macro-code").value;
    const parsed = parser.parseProgram(text);
    const result = validator.validateProgram(parsed.ast, parsed.errors);
    if (!result.ok) {
      state.validation = result;
      renderStatus();
      hooks.onToast("Text má chyby — vizuální editor by o program přišel. Nejdřív je oprav.");
      return;
    }
    state.ast = parsed.ast;
    state.mode = "visual";
    state.selection = null;
    state.target = null;
    state.validation = result;
    touched();
    render();
  }

  function setType(type) {
    if (type === state.type) {
      return;
    }
    if (type === TYPE.COMPLEX) {
      state.type = TYPE.COMPLEX;
      if (!String(state.program).trim() && String(state.seq).trim()) {
        const converted = simpleParser.simpleToV2Text(state.seq, { loop: true, delayMin: 200, delayMax: 800 });
        const parsed = parser.parseProgram(converted);
        state.ast = parsed.ast;
        hooks.onToast("Sekvence převedená do jazyka V2");
      } else if (!state.ast) {
        state.ast = ast.newProgram();
      }
      state.mode = "visual";
    } else {
      state.type = TYPE.SIMPLE;
    }
    state.validation = null;
    touched();
    render();
  }

  // ---------- render ----------
  function render() {
    const complex = state.type === TYPE.COMPLEX;
    $("macro-slot-no").textContent = String(state.index + 1);
    if (document.activeElement !== $("macro-name")) {
      $("macro-name").value = state.name;
    }
    [...$("macro-type").children].forEach((btn) => {
      btn.classList.toggle("is-on", btn.dataset.type === state.type);
    });
    [...$("macro-mode").children].forEach((btn) => {
      btn.classList.toggle("is-on", btn.dataset.mode === state.mode);
    });
    $("macro-mode").hidden = !complex;
    $("macro-side").hidden = !complex;
    $("macro-simple").hidden = complex;
    $("macro-visual").hidden = !complex || state.mode !== "visual";
    $("macro-code").hidden = !complex || state.mode !== "code";

    if (!complex) {
      if (document.activeElement !== $("macro-simple-seq")) {
        $("macro-simple-seq").value = state.seq;
      }
      renderSimplePreview();
      renderStatus();
      return;
    }
    if (state.mode === "code") {
      if (document.activeElement !== $("macro-code")) {
        $("macro-code").value = state.codeText;
      }
    } else {
      renderVisual();
    }
    renderPalette();
    renderHelp();
    renderStatus();
  }

  function renderSimplePreview() {
    const root = $("macro-simple-preview");
    root.textContent = "";
    const result = validator.validateSimple(state.seq, { loop: true });
    const head = el("div", "prev-head", "Co to udělá");
    root.appendChild(head);
    const pre = el("pre", "help-code", simpleParser.simpleToV2Text(state.seq, { loop: true }) || "—");
    root.appendChild(pre);
    if (result.warnings.length) {
      const list = el("ul", "issue-list");
      result.warnings.forEach((warn) => list.appendChild(el("li", "issue warn", `⚠ ${warn.message}`)));
      root.appendChild(list);
    }
  }

  function readMaxPref() {
    try {
      return localStorage.getItem("klikac.macroEditor.max") === "1";
    } catch {
      return false;
    }
  }

  function setMaximized(on) {
    state.maximized = !!on;
    $("macro-modal").classList.toggle("is-max", state.maximized);
    const btn = $("macro-max");
    btn.setAttribute("aria-pressed", state.maximized ? "true" : "false");
    btn.title = state.maximized ? "Obnovit velikost" : "Maximalizovat";
    btn.textContent = state.maximized ? "⛶" : "⤢";
    try {
      localStorage.setItem("klikac.macroEditor.max", state.maximized ? "1" : "0");
    } catch {
      /* private mode */
    }
  }

  function snapshotSlot() {
    if (state.type === TYPE.COMPLEX && state.mode === "code") {
      state.program = $("macro-code").value;
      state.codeText = state.program;
    } else if (state.type === TYPE.COMPLEX) {
      syncText();
    }
    return {
      name: state.name,
      type: state.type,
      seq: state.seq,
      program: state.program,
    };
  }

  function loadSlotFields(slot) {
    state.name = slot.name || "";
    state.type = slot.type === TYPE.COMPLEX ? TYPE.COMPLEX : TYPE.SIMPLE;
    state.seq = slot.seq || "";
    state.program = slot.program || "";
    state.selection = null;
    state.target = null;
    state.helpId = "";
    state.validation = null;
    state.mode = "visual";

    if (state.type === TYPE.COMPLEX) {
      const parsed = parser.parseProgram(state.program);
      if (parsed.errors.length) {
        state.ast = parsed.ast;
        state.mode = "code";
        state.codeText = state.program;
        state.validation = validator.validateProgram(parsed.ast, parsed.errors);
      } else {
        state.ast = parsed.ast;
        syncText();
      }
    } else {
      state.ast = ast.newProgram();
    }
  }

  function hasContent() {
    return state.type === TYPE.COMPLEX
      ? !!String(state.program || "").trim()
      : !!String(state.seq || "").trim();
  }

  // ---------- otevření / zavření ----------
  function open(slot, callbacks) {
    hooks = { onSave: () => {}, onToast: () => {}, ...(callbacks || {}) };
    state.open = true;
    state.index = slot.index;
    loadSlotFields(slot);
    setMaximized(readMaxPref());
    $("macro-modal").hidden = false;
    render();
    if (state.type === TYPE.COMPLEX) {
      runValidation(true);
    }
  }

  function close() {
    if (!state.open) {
      return;
    }
    if (state.type === TYPE.COMPLEX && state.mode === "code") {
      const text = $("macro-code").value;
      const parsed = parser.parseProgram(text);
      state.program = text;
      if (!parsed.errors.length) {
        state.ast = parsed.ast;
      }
      save();
    } else if (state.type === TYPE.COMPLEX) {
      syncText();
      save();
    } else {
      save();
    }
    state.open = false;
    $("macro-modal").hidden = true;
  }

  // ---------- události ----------
  $("macro-close").addEventListener("click", close);
  $("macro-backdrop").addEventListener("click", close);
  $("macro-max").addEventListener("click", () => setMaximized(!state.maximized));
  $("macro-head").addEventListener("dblclick", (ev) => {
    if (ev.target.closest("input, button, textarea, select, label")) {
      return;
    }
    setMaximized(!state.maximized);
  });

  async function exportCurrent() {
    if (!window.ovladac || typeof window.ovladac.exportMacro !== "function") {
      hooks.onToast("Export makra v tomhle okně nejde.");
      return;
    }
    try {
      const result = await window.ovladac.exportMacro(snapshotSlot());
      if (result && result.canceled) {
        return;
      }
      hooks.onToast("Makro uložené");
    } catch (err) {
      hooks.onToast(err.message || "Export se nepovedl");
    }
  }

  async function importCurrent() {
    if (!window.ovladac || typeof window.ovladac.importMacro !== "function") {
      hooks.onToast("Načtení makra v tomhle okně nejde.");
      return;
    }
    snapshotSlot();
    if (hasContent() && !window.confirm("Nahradit toto makro souborem? Rozepsané změny v tomhle slotu zmizí.")) {
      return;
    }
    try {
      const result = await window.ovladac.importMacro();
      if (result && result.canceled) {
        return;
      }
      loadSlotFields(result.macro);
      save();
      render();
      if (state.type === TYPE.COMPLEX) {
        runValidation(true);
      }
      hooks.onToast("Makro načtené");
    } catch (err) {
      hooks.onToast(err.message || "Načtení se nepovedlo");
    }
  }

  $("macro-export").addEventListener("click", () => {
    exportCurrent();
  });
  $("macro-import").addEventListener("click", () => {
    importCurrent();
  });

  $("macro-name").addEventListener("input", () => {
    state.name = $("macro-name").value;
    save();
  });

  $("macro-simple-seq").addEventListener("input", () => {
    state.seq = $("macro-simple-seq").value;
    state.validation = null;
    save();
    renderSimplePreview();
  });

  $("macro-type").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-type]");
    if (btn) {
      setType(btn.dataset.type);
    }
  });

  $("macro-mode").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-mode]");
    if (btn) {
      setMode(btn.dataset.mode);
    }
  });

  $("macro-code").addEventListener("input", () => {
    state.codeText = $("macro-code").value;
    state.program = state.codeText;
    state.validation = null;
    save();
  });

  $("macro-validate").addEventListener("click", () => runValidation(false));

  $("macro-issues").addEventListener("click", (ev) => {
    const item = ev.target.closest("[data-line]");
    if (item) {
      gotoLine(Number(item.dataset.line));
    }
  });

  $("macro-palette").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-construct]");
    if (btn) {
      insertConstruct(btn.dataset.construct);
    }
  });

  $("macro-palette").addEventListener("mouseover", (ev) => {
    const btn = ev.target.closest("[data-construct]");
    if (btn && btn.dataset.construct !== state.helpId) {
      state.helpId = btn.dataset.construct;
      renderPalette();
      renderHelp();
    }
  });

  $("macro-visual").addEventListener("click", (ev) => {
    const add = ev.target.closest(".blk-add[data-owner]");
    if (add) {
      state.target = { ownerId: add.dataset.owner, key: add.dataset.key };
      paintSelection();
      return;
    }
    const tool = ev.target.closest("[data-act]");
    if (tool) {
      nodeAction(tool.dataset.id, tool.dataset.act, tool.dataset.branch);
      return;
    }
    const blk = ev.target.closest(".blk");
    if (blk) {
      state.selection = blk.dataset.id;
      state.target = null;
      const spec = ast.constructByKind(blk.dataset.kind);
      state.helpId = spec ? spec.id : "";
      paintSelection();
    }
  });

  $("macro-visual").addEventListener("change", (ev) => {
    const target = ev.target;
    if (target.dataset && (target.dataset.field || target.dataset.branch)) {
      const error = applyFieldChange(target);
      if (!error && (target.tagName === "SELECT" || target.dataset.part === "unit" || target.dataset.part === "op")) {
        render();
      }
    }
  });

  $("macro-visual").addEventListener("input", (ev) => {
    const target = ev.target;
    if (target.tagName === "INPUT" && target.type === "text") {
      applyFieldChange(target);
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (!state.open) {
      return;
    }
    if (ev.key === "F11") {
      ev.preventDefault();
      setMaximized(!state.maximized);
      return;
    }
    if (ev.key === "Escape") {
      close();
    }
  });

  // ---------- shrnutí pro seznam sekvencí ----------
  function summary(slot) {
    if (slot.type !== TYPE.COMPLEX) {
      return null;
    }
    const text = String(slot.program || "").trim();
    if (!text) {
      return { ok: false, label: "prázdný program", detail: "" };
    }
    const result = validator.validateText(text);
    if (result.ok) {
      const lines = text.split("\n").length;
      return { ok: true, label: `✓ validní · ${lines} ř.`, detail: text.split("\n")[0] };
    }
    return {
      ok: false,
      label: `❌ ${result.errors.length} ${plural(result.errors.length, "chyba", "chyby", "chyb")}`,
      detail: result.errors[0].message,
    };
  }

  window.MacroEditor = {
    open,
    close,
    isOpen: () => state.open,
    slotIndex: () => state.index,
    summary,
  };
})();
