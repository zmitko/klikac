// Parser jazyka V2: text -> AST. Chyby se sbírají, parser se snaží pokračovat,
// aby validace uměla nahlásit víc problémů naráz.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({ ast: require("./ast"), lexer: require("./lexer"), keymap: require("./keymap") });
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.parser = factory(root.KlikacMacro);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (dep) {
  const ast = dep.ast;
  const lexer = dep.lexer;
  const keymap = dep.keymap;

  const BLOCK_END = "KONEC";
  const RESERVED = new Set([
    "STISK", "CEKEJ", "OPAKUJ", "DOKOLA", "PO", "DOBU", "KAZDYCH", "POKUD", "JINAK",
    "NASTAV", "ZVYS", "SNIZ", "NAHODNE", "SPUST", "MAKRO", "BREAK", "CONTINUE", "STOP",
    "VYPIS", "KONEC", "NEBO", "A", "NE", "TED", "CAS", "UPLYNULO", "DO", "O", "X",
  ]);

  function upper(value) {
    return String(value == null ? "" : value).toUpperCase();
  }

  class Cursor {
    constructor(tokens, line, errors) {
      this.tokens = tokens;
      this.line = line;
      this.errors = errors;
      this.pos = 0;
    }

    get eof() {
      return this.pos >= this.tokens.length;
    }

    peek(offset) {
      return this.tokens[this.pos + (offset || 0)] || null;
    }

    next() {
      const token = this.tokens[this.pos] || null;
      this.pos += 1;
      return token;
    }

    isWord(value, offset) {
      const token = this.peek(offset);
      return !!token && token.type === "word" && upper(token.value) === upper(value);
    }

    takeWord(value) {
      if (this.isWord(value)) {
        this.pos += 1;
        return true;
      }
      return false;
    }

    isPunct(value, offset) {
      const token = this.peek(offset);
      return !!token && token.type === "punct" && token.value === value;
    }

    takePunct(value) {
      if (this.isPunct(value)) {
        this.pos += 1;
        return true;
      }
      return false;
    }

    fail(message, code) {
      const token = this.peek() || this.tokens[this.tokens.length - 1] || null;
      this.errors.push({
        line: this.line,
        col: token ? token.col : 1,
        message,
        code: code || "SYNTAX",
      });
      this.pos = this.tokens.length;
      return null;
    }

    expectEnd(what) {
      if (!this.eof) {
        const token = this.peek();
        this.errors.push({
          line: this.line,
          col: token.col,
          message: `${what}: nerozumím „${token.value}“ na konci řádku.`,
          code: "SYNTAX",
        });
        this.pos = this.tokens.length;
        return false;
      }
      return true;
    }
  }

  function parseProgram(source) {
    const errors = [];
    const { lines, errors: lexErrors } = lexer.tokenize(source);
    lexErrors.forEach((err) => errors.push(err));

    const state = { lines, pos: 0, errors };
    const prog = ast.program([], []);
    prog.line = 1;

    while (state.pos < lines.length) {
      const current = lines[state.pos];
      const head = upper(current.tokens[0] && current.tokens[0].value);
      if (head === BLOCK_END || head === "JINAK" || head === "NEBO") {
        errors.push({
          line: current.line,
          col: current.tokens[0].col,
          message: `„${current.text}“ nemá otevřenou konstrukci.`,
          code: "STRUCTURE",
        });
        state.pos += 1;
        continue;
      }
      const stmt = parseStatement(state, 0);
      if (!stmt) {
        continue;
      }
      if (stmt.kind === "MacroDef") {
        prog.macros.push(stmt);
      } else {
        prog.body.push(stmt);
      }
    }

    return { ast: prog, errors };
  }

  // Čte příkazy, dokud nenarazí na řádek ze stops (ten nechá nezkonzumovaný).
  // Vrací { body, stop } kde stop je { head, line } nebo null při konci vstupu.
  function parseBlock(state, depth, stops) {
    const body = [];
    const stopSet = new Set((stops || []).map(upper));
    while (state.pos < state.lines.length) {
      const current = state.lines[state.pos];
      const first = current.tokens[0];
      const head = upper(first && first.value);
      if (stopSet.has(head)) {
        return { body, stop: { head, line: current.line, tokens: current.tokens, text: current.text } };
      }
      if (stopSet.has("%") && isWeightLabel(current.tokens)) {
        return { body, stop: { head: "%", line: current.line, tokens: current.tokens, text: current.text } };
      }
      if (head === BLOCK_END || head === "JINAK" || head === "NEBO") {
        state.errors.push({
          line: current.line,
          col: first.col,
          message: `„${current.text}“ sem nepatří.`,
          code: "STRUCTURE",
        });
        state.pos += 1;
        continue;
      }
      const stmt = parseStatement(state, depth);
      if (stmt) {
        body.push(stmt);
      }
    }
    return { body, stop: null };
  }

  function isWeightLabel(tokens) {
    return !!tokens
      && tokens.length >= 2
      && tokens[0].type === "number"
      && tokens[1].type === "punct"
      && tokens[1].value === "%";
  }

  function requireEnd(state, opener, openerLine, block) {
    if (block.stop && block.stop.head === BLOCK_END) {
      state.pos += 1;
      return true;
    }
    state.errors.push({
      line: openerLine,
      message: `Chybí ${BLOCK_END} konstrukce ${opener} (otevřená na řádku ${openerLine}).`,
      code: "STRUCTURE",
    });
    return false;
  }

  function parseStatement(state, depth) {
    const current = state.lines[state.pos];
    const tokens = current.tokens;
    const line = current.line;
    const first = tokens[0];

    if (first.type === "comment") {
      state.pos += 1;
      const node = ast.comment(first.value);
      node.line = line;
      return node;
    }

    const head = upper(first.value);
    const cursor = new Cursor(tokens, line, state.errors);

    switch (head) {
      case "STISK":
        state.pos += 1;
        return finishSimple(cursor, line, parsePress(cursor, line));
      case "CEKEJ":
        state.pos += 1;
        return finishSimple(cursor, line, parseWait(cursor, line));
      case "NASTAV":
        state.pos += 1;
        return finishSimple(cursor, line, parseSet(cursor, line));
      case "ZVYS":
      case "SNIZ":
        state.pos += 1;
        return finishSimple(cursor, line, parseStep(cursor, line, head === "ZVYS"));
      case "SPUST":
        state.pos += 1;
        return finishSimple(cursor, line, parseCall(cursor, line));
      case "VYPIS":
        state.pos += 1;
        return finishSimple(cursor, line, parsePrint(cursor, line));
      case "BREAK":
      case "CONTINUE":
      case "STOP": {
        state.pos += 1;
        cursor.next();
        cursor.expectEnd(head);
        const node = head === "BREAK" ? ast.breakStmt() : head === "CONTINUE" ? ast.continueStmt() : ast.stopStmt();
        node.line = line;
        return node;
      }
      case "OPAKUJ":
        return parseRepeat(state, depth, cursor, line);
      case "DOKOLA":
        return parseForever(state, depth, cursor, line);
      case "PO":
        return parseDuring(state, depth, cursor, line);
      case "KAZDYCH":
        return parseEvery(state, depth, cursor, line);
      case "POKUD":
        return parseIf(state, depth, cursor, line);
      case "NAHODNE":
        return parseChoice(state, depth, cursor, line);
      case "MAKRO":
        return parseMacroDef(state, depth, cursor, line);
      default:
        state.pos += 1;
        state.errors.push({
          line,
          col: first.col,
          message: `Neznámý příkaz „${first.value}“.`,
          code: "SYNTAX",
        });
        return null;
    }
  }

  function finishSimple(cursor, line, node) {
    if (!node) {
      return null;
    }
    node.line = line;
    return node;
  }

  function parsePress(cursor, line) {
    cursor.next();
    const token = cursor.next();
    if (!token) {
      return cursor.fail("STISK: chybí klávesa, třeba STISK F1.");
    }
    const raw = String(token.value);
    if (!cursor.expectEnd("STISK")) {
      return null;
    }
    // V AST držíme klávesu v podobě, kterou bere destička; původní zápis
    // si necháme jen pro chybovou hlášku.
    const node = ast.press(keymap.normalizeKey(raw) || raw);
    node.line = line;
    if (node.key !== raw) {
      node.rawKey = raw;
    }
    return node;
  }

  function parseWait(cursor, line) {
    cursor.next();
    if (cursor.takeWord("NAHODNE")) {
      const from = cursor.next();
      if (!from || from.type !== "duration") {
        return cursor.fail("CEKEJ NAHODNE: čekám rozsah s jednotkou, třeba CEKEJ NAHODNE 2s-5s.");
      }
      if (!cursor.takePunct("-")) {
        return cursor.fail("CEKEJ NAHODNE: mezi hodnotami chybí „-“ (CEKEJ NAHODNE 2s-5s).");
      }
      const to = cursor.next();
      if (!to || to.type !== "duration") {
        return cursor.fail("CEKEJ NAHODNE: druhá hodnota musí mít jednotku, třeba 5s.");
      }
      if (!cursor.expectEnd("CEKEJ")) {
        return null;
      }
      const node = ast.waitRandom(from.value, to.value);
      node.line = line;
      return node;
    }
    if (cursor.takeWord("DO")) {
      const token = cursor.next();
      if (!token || token.type !== "time") {
        return cursor.fail("CEKEJ DO: čekám čas HH:MM, třeba CEKEJ DO 18:00.");
      }
      if (!cursor.expectEnd("CEKEJ")) {
        return null;
      }
      const node = ast.waitUntil(token.value);
      node.line = line;
      return node;
    }
    const token = cursor.next();
    if (!token) {
      return cursor.fail("CEKEJ: chybí doba, třeba CEKEJ 3s.");
    }
    if (token.type !== "duration") {
      return cursor.fail("CEKEJ: doba musí mít jednotku ms, s, min nebo h (CEKEJ 500ms, CEKEJ 3s).");
    }
    if (!cursor.expectEnd("CEKEJ")) {
      return null;
    }
    const node = ast.waitFixed(token.value);
    node.line = line;
    return node;
  }

  function parseVarName(cursor, what) {
    const token = cursor.next();
    if (!token || token.type !== "word") {
      cursor.fail(`${what}: chybí název proměnné.`);
      return null;
    }
    const name = upper(token.value);
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(token.value)) {
      cursor.fail(`${what}: „${token.value}“ není platný název proměnné.`);
      return null;
    }
    return name;
  }

  function parseSet(cursor, line) {
    cursor.next();
    const name = parseVarName(cursor, "NASTAV");
    if (!name) {
      return null;
    }
    const eq = cursor.next();
    if (!eq || eq.type !== "op" || eq.value !== "=") {
      return cursor.fail("NASTAV: chybí „=“ (NASTAV POCET = 0).");
    }
    const value = parseExpression(cursor);
    if (!value) {
      return null;
    }
    if (!cursor.expectEnd("NASTAV")) {
      return null;
    }
    const node = ast.setVar(name, value);
    node.line = line;
    return node;
  }

  function parseStep(cursor, line, isInc) {
    const word = isInc ? "ZVYS" : "SNIZ";
    cursor.next();
    const name = parseVarName(cursor, word);
    if (!name) {
      return null;
    }
    let by = ast.num(1);
    if (cursor.takeWord("O")) {
      const parsed = parseExpression(cursor);
      if (!parsed) {
        return null;
      }
      by = parsed;
    } else if (!cursor.eof) {
      return cursor.fail(`${word}: chybí „O“ (${word} ${name} O 1).`);
    }
    if (!cursor.expectEnd(word)) {
      return null;
    }
    const node = isInc ? ast.incVar(name, by) : ast.decVar(name, by);
    node.line = line;
    return node;
  }

  function parseCall(cursor, line) {
    cursor.next();
    const token = cursor.next();
    if (!token || token.type !== "word") {
      return cursor.fail("SPUST: chybí název makra, třeba SPUST M1.");
    }
    const name = upper(token.value);
    const args = [];
    if (cursor.takePunct("(")) {
      if (!cursor.takePunct(")")) {
        for (;;) {
          const arg = parseExpression(cursor);
          if (!arg) {
            return null;
          }
          args.push(arg);
          if (cursor.takePunct(",")) {
            continue;
          }
          if (cursor.takePunct(")")) {
            break;
          }
          return cursor.fail("SPUST: v parametrech chybí „)“.");
        }
      }
    }
    if (!cursor.expectEnd("SPUST")) {
      return null;
    }
    const node = ast.call(name, args);
    node.line = line;
    return node;
  }

  function parsePrint(cursor, line) {
    cursor.next();
    const value = parseExpression(cursor);
    if (!value) {
      return null;
    }
    if (!cursor.expectEnd("VYPIS")) {
      return null;
    }
    const node = ast.print(value);
    node.line = line;
    return node;
  }

  function parseRepeat(state, depth, cursor, line) {
    state.pos += 1;
    cursor.next();
    const count = parseExpression(cursor);
    if (!count) {
      skipBlockAfterBadHeader(state, depth, "OPAKUJ", line);
      return null;
    }
    cursor.takeWord("x");
    cursor.expectEnd("OPAKUJ");
    const block = parseBlock(state, depth + 1, [BLOCK_END]);
    requireEnd(state, "OPAKUJ", line, block);
    const node = ast.repeat(count, block.body);
    node.line = line;
    return node;
  }

  function parseForever(state, depth, cursor, line) {
    state.pos += 1;
    cursor.next();
    cursor.expectEnd("DOKOLA");
    const block = parseBlock(state, depth + 1, [BLOCK_END]);
    requireEnd(state, "DOKOLA", line, block);
    const node = ast.forever(block.body);
    node.line = line;
    return node;
  }

  function parseDuring(state, depth, cursor, line) {
    state.pos += 1;
    cursor.next();
    if (!cursor.takeWord("DOBU")) {
      cursor.fail("PO DOBU: čekám „PO DOBU 30s“.");
      const skipped = parseBlock(state, depth + 1, [BLOCK_END]);
      requireEnd(state, "PO DOBU", line, skipped);
      return null;
    }
    const token = cursor.next();
    let ms = 30000;
    if (!token || token.type !== "duration") {
      cursor.fail("PO DOBU: doba musí mít jednotku, třeba 30s.");
    } else {
      ms = token.value;
      cursor.expectEnd("PO DOBU");
    }
    const block = parseBlock(state, depth + 1, [BLOCK_END]);
    requireEnd(state, "PO DOBU", line, block);
    const node = ast.during(ms, block.body);
    node.line = line;
    return node;
  }

  function parseEvery(state, depth, cursor, line) {
    state.pos += 1;
    cursor.next();
    const token = cursor.next();
    let ms = 10000;
    if (!token || token.type !== "duration") {
      cursor.fail("KAZDYCH: perioda musí mít jednotku, třeba KAZDYCH 10s.");
    } else {
      ms = token.value;
      cursor.expectEnd("KAZDYCH");
    }
    const block = parseBlock(state, depth + 1, [BLOCK_END]);
    requireEnd(state, "KAZDYCH", line, block);
    const node = ast.every(ms, block.body);
    node.line = line;
    return node;
  }

  function parseIf(state, depth, cursor, line) {
    state.pos += 1;
    cursor.next();
    const cond = parseExpression(cursor);
    if (cond) {
      cursor.expectEnd("POKUD");
    }
    const block = parseBlock(state, depth + 1, [BLOCK_END, "JINAK"]);
    let elseBody = null;
    let closed = false;
    if (block.stop && block.stop.head === "JINAK") {
      const elseCursor = new Cursor(block.stop.tokens, block.stop.line, state.errors);
      elseCursor.next();
      elseCursor.expectEnd("JINAK");
      state.pos += 1;
      const elseBlock = parseBlock(state, depth + 1, [BLOCK_END]);
      elseBody = elseBlock.body;
      closed = requireEnd(state, "POKUD", line, elseBlock);
    } else {
      closed = requireEnd(state, "POKUD", line, block);
    }
    if (!cond) {
      return null;
    }
    const node = ast.ifStmt(cond, block.body, elseBody);
    node.line = line;
    node.closed = closed;
    return node;
  }

  function parseChoice(state, depth, cursor, line) {
    state.pos += 1;
    cursor.next();
    cursor.expectEnd("NAHODNE");
    const branches = [];
    let block = parseBlock(state, depth + 1, [BLOCK_END, "NEBO", "%"]);
    const weighted = block.stop && block.stop.head === "%" && block.body.length === 0;
    if (weighted) {
      // NAHODNE\n 70%: ... \n 20%: ... \n KONEC
      while (state.pos < state.lines.length) {
        const current = state.lines[state.pos];
        if (!isWeightLabel(current.tokens)) {
          break;
        }
        const weight = current.tokens[0].value;
        const labelCursor = new Cursor(current.tokens, current.line, state.errors);
        labelCursor.next();
        labelCursor.next();
        if (!labelCursor.takePunct(":")) {
          labelCursor.fail("NAHODNE: za procenty chybí „:“ (70%:).");
        }
        const inlineStart = labelCursor.pos;
        state.pos += 1;
        const branchBlock = parseBlock(state, depth + 1, [BLOCK_END, "%"]);
        const body = branchBlock.body;
        if (current.tokens.length > inlineStart) {
          state.errors.push({
            line: current.line,
            message: "NAHODNE: příkaz napiš na další řádek pod „70%:“.",
            code: "SYNTAX",
          });
        }
        branches.push(ast.choiceBranch(body, weight));
        block = branchBlock;
        if (branchBlock.stop && branchBlock.stop.head === BLOCK_END) {
          break;
        }
      }
      requireEnd(state, "NAHODNE", line, block);
    } else {
      branches.push(ast.choiceBranch(block.body, null));
      while (block.stop && block.stop.head === "NEBO") {
        const sepCursor = new Cursor(block.stop.tokens, block.stop.line, state.errors);
        sepCursor.next();
        sepCursor.expectEnd("NEBO");
        state.pos += 1;
        block = parseBlock(state, depth + 1, [BLOCK_END, "NEBO"]);
        branches.push(ast.choiceBranch(block.body, null));
      }
      requireEnd(state, "NAHODNE", line, block);
    }
    const node = ast.choice(branches);
    node.line = line;
    return node;
  }

  function parseMacroDef(state, depth, cursor, line) {
    state.pos += 1;
    cursor.next();
    const token = cursor.next();
    let name = "";
    if (!token || token.type !== "word") {
      cursor.fail("MAKRO: chybí název, třeba MAKRO M1.");
    } else {
      name = upper(token.value);
    }
    const params = [];
    if (cursor.takePunct("(")) {
      if (!cursor.takePunct(")")) {
        for (;;) {
          const param = cursor.next();
          if (!param || param.type !== "word") {
            cursor.fail("MAKRO: parametr musí být název, třeba MAKRO M1(POCET).");
            break;
          }
          params.push(upper(param.value));
          if (cursor.takePunct(",")) {
            continue;
          }
          if (cursor.takePunct(")")) {
            break;
          }
          cursor.fail("MAKRO: v parametrech chybí „)“.");
          break;
        }
      }
    }
    cursor.expectEnd("MAKRO");
    const block = parseBlock(state, depth + 1, [BLOCK_END]);
    requireEnd(state, "MAKRO", line, block);
    if (depth > 0) {
      state.errors.push({
        line,
        message: "MAKRO se definuje na nejvyšší úrovni, ne uvnitř jiné konstrukce.",
        code: "STRUCTURE",
      });
    }
    if (!name) {
      return null;
    }
    const node = ast.macroDef(name, params, block.body);
    node.line = line;
    return node;
  }

  function skipBlockAfterBadHeader(state, depth, opener, line) {
    const block = parseBlock(state, depth + 1, [BLOCK_END]);
    requireEnd(state, opener, line, block);
  }

  // ---------- výrazy ----------
  function parseExpression(cursor) {
    return parseOr(cursor);
  }

  function parseOr(cursor) {
    let left = parseAnd(cursor);
    if (!left) {
      return null;
    }
    while (cursor.isWord("NEBO")) {
      cursor.next();
      const right = parseAnd(cursor);
      if (!right) {
        return null;
      }
      left = ast.binary("NEBO", left, right);
    }
    return left;
  }

  function parseAnd(cursor) {
    let left = parseNot(cursor);
    if (!left) {
      return null;
    }
    while (cursor.isWord("A")) {
      cursor.next();
      const right = parseNot(cursor);
      if (!right) {
        return null;
      }
      left = ast.binary("A", left, right);
    }
    return left;
  }

  function parseNot(cursor) {
    if (cursor.isWord("NE")) {
      cursor.next();
      const expr = parseNot(cursor);
      if (!expr) {
        return null;
      }
      return ast.unary("NE", expr);
    }
    return parseCompare(cursor);
  }

  function parseCompare(cursor) {
    const left = parsePrimary(cursor);
    if (!left) {
      return null;
    }
    const token = cursor.peek();
    if (token && token.type === "op" && ast.COMPARE_OPS.includes(token.value)) {
      cursor.next();
      const right = parsePrimary(cursor);
      if (!right) {
        return null;
      }
      return ast.binary(token.value, left, right);
    }
    return left;
  }

  function parsePrimary(cursor) {
    const token = cursor.next();
    if (!token) {
      return cursor.fail("Chybí hodnota výrazu.");
    }
    if (token.type === "number") {
      // rozsah „1-100“ jen za NAHODNE, jinak je to číslo
      return ast.num(token.value);
    }
    if (token.type === "duration") {
      return ast.duration(token.value);
    }
    if (token.type === "time") {
      return ast.timeLit(token.minutes);
    }
    if (token.type === "string") {
      return ast.str(token.value);
    }
    if (token.type === "punct" && token.value === "(") {
      const inner = parseExpression(cursor);
      if (!inner) {
        return null;
      }
      if (!cursor.takePunct(")")) {
        return cursor.fail("Chybí „)“.");
      }
      return inner;
    }
    if (token.type === "word") {
      const word = upper(token.value);
      if (word === "TED") {
        return ast.now();
      }
      if (word === "CAS") {
        return ast.clock();
      }
      if (word === "UPLYNULO") {
        const nameToken = cursor.next();
        if (!nameToken || nameToken.type !== "word") {
          return cursor.fail("UPLYNULO: chybí proměnná, třeba UPLYNULO START.");
        }
        return ast.elapsed(upper(nameToken.value));
      }
      if (word === "NAHODNE") {
        const from = cursor.next();
        if (!from || from.type !== "number") {
          return cursor.fail("NAHODNE: čekám rozsah čísel, třeba NAHODNE 1-100.");
        }
        if (!cursor.takePunct("-")) {
          return cursor.fail("NAHODNE: mezi čísly chybí „-“ (NAHODNE 1-100).");
        }
        const to = cursor.next();
        if (!to || to.type !== "number") {
          return cursor.fail("NAHODNE: druhá hodnota rozsahu musí být číslo.");
        }
        return ast.randRange(from.value, to.value);
      }
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(token.value)) {
        return cursor.fail(`„${token.value}“ není platný název proměnné.`);
      }
      return ast.varRef(word);
    }
    return cursor.fail(`Nerozumím „${token.value}“ ve výrazu.`);
  }

  // Samostatné parsování podmínky / výrazu (pro vizuální editor).
  function parseExpressionText(text, label) {
    const errors = [];
    const { tokens, errors: lexErrors } = lexer.tokenizeLine(String(text == null ? "" : text), 1);
    lexErrors.forEach((err) => errors.push({ ...err, code: "SYNTAX" }));
    if (!tokens.length) {
      errors.push({ line: 1, message: `${label || "Výraz"}: je prázdný.`, code: "SYNTAX" });
      return { expr: null, errors };
    }
    const cursor = new Cursor(tokens, 1, errors);
    const expr = parseExpression(cursor);
    if (expr) {
      cursor.expectEnd(label || "Výraz");
    }
    return { expr: errors.length ? expr : expr, errors };
  }

  return { parseProgram, parseExpressionText, RESERVED };
});
