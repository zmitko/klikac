// AST -> text. Vizuální editor drží AST, textový režim si text generuje odsud.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({ ast: require("./ast") });
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.serialize = factory(root.KlikacMacro);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (dep) {
  const ast = dep.ast;
  const INDENT = "    ";

  function exprToText(expr) {
    if (!expr || typeof expr !== "object") {
      return "0";
    }
    switch (expr.kind) {
      case "Num":
        return String(expr.value);
      case "Str":
        return `"${String(expr.value).replace(/"/g, "")}"`;
      case "Var":
        return expr.name;
      case "Now":
        return "TED";
      case "Clock":
        return "CAS";
      case "TimeLit":
        return ast.minutesToTime(expr.minutes);
      case "Elapsed":
        return `UPLYNULO ${expr.name}`;
      case "RandRange":
        return `NAHODNE ${expr.min}-${expr.max}`;
      case "Duration":
        return ast.msToText(expr.ms);
      case "Unary":
        return `NE ${exprToText(expr.expr)}`;
      case "Binary": {
        const left = exprToText(expr.left);
        const right = exprToText(expr.right);
        return `${left} ${expr.op} ${right}`;
      }
      default:
        return "0";
    }
  }

  function waitToText(node) {
    if (node.mode === "random") {
      return `CEKEJ NAHODNE ${ast.msToText(node.minMs)}-${ast.msToText(node.maxMs)}`;
    }
    if (node.mode === "until") {
      return `CEKEJ DO ${node.time}`;
    }
    if (node.mode === "delay") {
      // Prodleva ze Simple makra (D / Dn) — v V2 se zapíše jako pevné čekání.
      const seconds = Number(node.seconds) || 0;
      return seconds > 0 ? `CEKEJ ${seconds}s` : "CEKEJ NAHODNE 200ms-800ms";
    }
    return `CEKEJ ${ast.msToText(node.ms)}`;
  }

  function stmtToLines(node, depth, out, map) {
    const pad = INDENT.repeat(depth);
    let first = true;
    const push = (text) => {
      out.push(`${pad}${text}`);
      if (map && first) {
        first = false;
        map.set(out.length, node.id);
        node.line = out.length;
      }
    };
    switch (node.kind) {
      case "Comment":
        push(`# ${node.text || ""}`.trimEnd());
        break;
      case "Press":
        push(`STISK ${node.key}`);
        break;
      case "Wait":
        push(waitToText(node));
        break;
      case "Repeat":
        // „OPAKUJ 5x“ u čísla, „OPAKUJ POCET x“ u proměnné (bez mezery by splynuly)
        push(`OPAKUJ ${exprToText(node.count)}${node.count && node.count.kind === "Num" ? "" : " "}x`);
        bodyToLines(node.body, depth + 1, out, map);
        push("KONEC");
        break;
      case "Forever":
        push("DOKOLA");
        bodyToLines(node.body, depth + 1, out, map);
        push("KONEC");
        break;
      case "During":
        push(`PO DOBU ${ast.msToText(node.ms)}`);
        bodyToLines(node.body, depth + 1, out, map);
        push("KONEC");
        break;
      case "Every":
        push(`KAZDYCH ${ast.msToText(node.ms)}`);
        bodyToLines(node.body, depth + 1, out, map);
        push("KONEC");
        break;
      case "If":
        push(`POKUD ${exprToText(node.cond)}`);
        bodyToLines(node.body, depth + 1, out, map);
        if (node.elseBody) {
          push("JINAK");
          bodyToLines(node.elseBody, depth + 1, out, map);
        }
        push("KONEC");
        break;
      case "Set":
        push(`NASTAV ${node.name} = ${exprToText(node.value)}`);
        break;
      case "Inc":
        push(`ZVYS ${node.name} O ${exprToText(node.by)}`);
        break;
      case "Dec":
        push(`SNIZ ${node.name} O ${exprToText(node.by)}`);
        break;
      case "Choice": {
        push("NAHODNE");
        const weighted = (node.branches || []).some((b) => b.weight != null);
        (node.branches || []).forEach((branch, index) => {
          if (weighted) {
            out.push(`${pad}${INDENT}${branch.weight == null ? 0 : branch.weight}%:`);
            bodyToLines(branch.body, depth + 2, out, map);
            return;
          }
          if (index > 0) {
            push("NEBO");
          }
          bodyToLines(branch.body, depth + 1, out, map);
        });
        push("KONEC");
        break;
      }
      case "Call":
        push(`SPUST ${node.name}${(node.args || []).length ? `(${node.args.map(exprToText).join(", ")})` : ""}`);
        break;
      case "MacroDef":
        push(`MAKRO ${node.name}${(node.params || []).length ? `(${node.params.join(", ")})` : ""}`);
        bodyToLines(node.body, depth + 1, out, map);
        push("KONEC");
        break;
      case "Break":
        push("BREAK");
        break;
      case "Continue":
        push("CONTINUE");
        break;
      case "Stop":
        push("STOP");
        break;
      case "Print":
        push(`VYPIS ${exprToText(node.value)}`);
        break;
      default:
        push(`# neznámá konstrukce ${node.kind}`);
        break;
    }
  }

  function bodyToLines(body, depth, out, map) {
    (body || []).forEach((node) => stmtToLines(node, depth, out, map));
  }

  function build(program, map) {
    const out = [];
    (program.macros || []).forEach((macro) => {
      stmtToLines(macro, 0, out, map);
      out.push("");
    });
    bodyToLines(program.body, 0, out, map);
    return out;
  }

  function toText(program) {
    if (!program) {
      return "";
    }
    return build(program, null).join("\n").trimEnd();
  }

  // Vygeneruje text a zároveň uzlům přepíše .line podle výsledných řádků,
  // takže chyba z validace ukáže na konkrétní blok ve vizuálním editoru.
  function annotate(program) {
    const map = new Map();
    if (!program) {
      return { text: "", byLine: map };
    }
    const out = build(program, map);
    return { text: out.join("\n").trimEnd(), byLine: map };
  }

  // Jednořádkový popis konstrukce pro hlavičku bloku ve vizuálním editoru.
  function nodeLabel(node) {
    const out = [];
    switch (node.kind) {
      case "Choice":
        return "NAHODNE";
      case "If":
        return `POKUD ${exprToText(node.cond)}`;
      case "MacroDef":
        return `MAKRO ${node.name}${(node.params || []).length ? `(${node.params.join(", ")})` : ""}`;
      default:
        stmtToLines({ ...node, body: [], elseBody: null, branches: [] }, 0, out);
        return (out[0] || "").trim();
    }
  }

  return { toText, annotate, exprToText, waitToText, nodeLabel };
});
