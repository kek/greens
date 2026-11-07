// Print JSON IR as EYG text that parser.js reads back.
//
// Programs from the structural editor are stored as IR. Printing them keeps
// them readable and lets the command line work with them. For IR built from
// the text syntax (and from the editor, which uses the same shapes),
// parse(print(ir)) gives back exactly the same IR. The few shapes the text
// syntax cannot express, such as a bare `cons` or an `extend` onto a
// non-empty record, throw a PrintError.

const INDENT = "  ";

export function print(ir) {
  return block(ir, "") + "\n";
}

// A sequence of lets, each on its own line, ending in an expression.
function block(node, indent) {
  const lines = [];
  for (;;) {
    if (node["0"] !== "l") break;
    const d = destructure(node);
    if (d) {
      lines.push(`let ${pattern(d.fields)} = ${expr(node.v, indent)}`);
      node = d.rest;
    } else {
      lines.push(`let ${node.l} = ${expr(node.v, indent)}`);
      node = node.t;
    }
    if (node["0"] === "z" && !node.c) return lines.join(`\n${indent}`);
  }
  lines.push(expr(node, indent));
  return lines.join(`\n${indent}`);
}

// let $ = value, then lets selecting fields of $, as written by the parser.
function destructure(node) {
  if (node.l !== "$") return null;
  const fields = [];
  let rest = node.t;
  while (
    rest["0"] === "l" &&
    rest.v["0"] === "a" &&
    rest.v.f["0"] === "g" &&
    rest.v.a["0"] === "v" &&
    rest.v.a.l === "$"
  ) {
    fields.push([rest.v.f.l, rest.l]);
    rest = rest.t;
  }
  return { fields, rest };
}

function pattern(fields) {
  return `{${fields.map(([field, name]) => (field === name ? field : `${field}: ${name}`)).join(", ")}}`;
}

function body(node, indent) {
  const inner = indent + INDENT;
  const text = block(node, inner);
  return text.includes("\n") || node["0"] === "l" ? `{\n${inner}${text}\n${indent}}` : `{ ${text} }`;
}

function lambda(node, indent) {
  const params = [];
  while (node["0"] === "f") {
    if (node.l === "$") {
      const d = destructureParam(node.b);
      params.push(pattern(d.fields));
      node = d.rest;
    } else {
      params.push(node.l);
      node = node.b;
    }
  }
  return `(${params.join(", ")}) -> ${body(node, indent)}`;
}

function destructureParam(b) {
  const fields = [];
  let rest = b;
  while (rest["0"] === "l" && rest.v["0"] === "a" && rest.v.f["0"] === "g" && rest.v.a["0"] === "v" && rest.v.a.l === "$") {
    fields.push([rest.v.f.l, rest.l]);
    rest = rest.t;
  }
  return { fields, rest };
}

// Unwind nested applications: f(a)(b) -> [f, [a, b]].
function spine(node) {
  const args = [];
  while (node["0"] === "a") {
    args.unshift(node.a);
    node = node.f;
  }
  return [node, args];
}

function string(s) {
  return `"${s.replace(/[\\"\n\t\r]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r" })[c])}"`;
}

function expr(node, indent) {
  switch (node["0"]) {
    case "v":
      return node.l;
    case "i":
      return String(node.v);
    case "s":
      return string(node.v);
    case "z":
      return "todo";
    case "u":
      return "{}";
    case "ta":
      return "[]";
    case "f":
      return lambda(node, indent);
    case "l":
      return block(node, indent);
    case "t":
      return node.l;
    case "p":
      return `perform ${node.l}`;
    case "h":
      return `handle ${node.l}`;
    case "b":
      return `!${node.l}`;
    case "#":
      return `#${node.l}`;
    case "a":
      return application(node, indent);
    default:
      return partial(node);
  }
}

function application(node, indent) {
  const list = listLiteral(node, indent);
  if (list) return list;
  const record = recordLiteral(node, indent);
  if (record) return record;
  const cases = matchLiteral(node, indent);
  if (cases) return cases;
  const [head, args] = spine(node);
  if (head["0"] === "g" && args.length >= 1) {
    return call(`${operand(args[0], indent)}.${head.l}`, args.slice(1), indent);
  }
  // A match applied to its subject is written `match subject { ... }`.
  if (node["0"] === "a" && isMatch(node.f)) {
    return `match ${expr(node.a, indent)} ${clauses(node.f, indent)}`;
  }
  if (["c", "e", "o", "m", "n", "g"].includes(head["0"])) return partial(head);
  return call(operand(head, indent), args, indent);
}

// Expressions that are safe to call or select from directly.
function operand(node, indent) {
  return expr(node, indent);
}

function call(callee, args, indent) {
  if (args.length === 0) return callee;
  return `${callee}(${args.map((a) => expr(a, indent)).join(", ")})`;
}

function listLiteral(node, indent) {
  const items = [];
  let n = node;
  while (n["0"] === "a" && n.f["0"] === "a" && n.f.f["0"] === "c") {
    items.push(n.f.a);
    n = n.a;
  }
  if (!items.length) return null;
  const shown = items.map((i) => expr(i, indent));
  if (n["0"] !== "ta") shown.push(`..${expr(n, indent)}`);
  return `[${shown.join(", ")}]`;
}

function recordLiteral(node, indent) {
  for (const [code, close] of [["e", (n) => (n["0"] === "u" ? "" : null)], ["o", (n) => `, ..${expr(n, indent)}`]]) {
    const fields = [];
    let n = node;
    while (n["0"] === "a" && n.f["0"] === "a" && n.f.f["0"] === code) {
      fields.push([n.f.f.l, n.f.a]);
      n = n.a;
    }
    if (!fields.length) continue;
    const tail = close(n);
    if (tail === null) return partial(node.f.f);
    const shown = fields.map(([l, v]) => (v["0"] === "v" && v.l === l && code === "e" ? l : `${l}: ${expr(v, indent)}`));
    return `{${shown.join(", ")}${tail}}`;
  }
  return null;
}

function isMatch(node) {
  let n = node;
  while (n["0"] === "a" && n.f["0"] === "a" && n.f.f["0"] === "m") n = n.a;
  return n !== node;
}

function matchLiteral(node, indent) {
  return isMatch(node) ? `match ${clauses(node, indent)}` : null;
}

function clauses(node, indent) {
  const inner = indent + INDENT;
  const lines = [];
  let n = node;
  while (n["0"] === "a" && n.f["0"] === "a" && n.f.f["0"] === "m") {
    lines.push(`${n.f.f.l}${branch(n.f.a, inner)}`);
    n = n.a;
  }
  if (n["0"] !== "n") lines.push(`| ${expr(n, inner)}`);
  return `{\n${inner}${lines.join(`\n${inner}`)}\n${indent}}`;
}

function branch(node, indent) {
  return node["0"] === "f" ? lambda(node, indent) : ` ${expr(node, indent)}`;
}

// The text syntax only has cons, extend, overwrite, select and case as
// sugar, so a partial application of one of them cannot be written as text.
function partial(head) {
  throw new PrintError(`a bare ${NAMES[head["0"]] ?? head["0"]} has no text syntax`);
}

const NAMES = { c: "list cons", e: "record extend", o: "record overwrite", g: "field select", m: "match case", n: "empty match" };

export class PrintError extends Error {}
