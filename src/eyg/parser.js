// Parser for EYG's text syntax, producing the JSON IR from the EYG spec.
// It mirrors eyg-lang's packages/gleam_parser (the syntax guide is
// guides/syntax.md upstream). References and imports are parsed so that the
// validator can reject them with a clear message.

export class ParseError extends Error {
  constructor(message, offset, source) {
    const { line, column } = position(source, offset);
    super(`${message} at ${line}:${column}`);
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

function position(source, offset) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < Math.min(offset, source.length); i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

const KEYWORDS = new Set(["let", "match", "perform", "handle", "todo", "import"]);
const PUNCTUATION = [
  ["->", "->"], ["..", ".."], ["(", "("], [")", ")"], ["{", "{"], ["}", "}"], ["[", "["], ["]", "]"],
  ["=", "="], [",", ","], [".", "."], [":", ":"], ["-", "-"], ["!", "!"], ["|", "|"], ["#", "#"], ["@", "@"],
];
const ESCAPES = { '"': '"', "\\": "\\", t: "\t", r: "\r", n: "\n" };

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  const err = (m, at = i) => {
    throw new ParseError(m, at, source);
  };
  outer: while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }
    for (const [text, kind] of PUNCTUATION) {
      if (source.startsWith(text, i)) {
        tokens.push({ kind, at: i });
        i += text.length;
        continue outer;
      }
    }
    if (c === '"') {
      const start = i++;
      let value = "";
      for (;;) {
        if (i >= source.length) err("Unterminated string literal", start);
        const ch = source[i];
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === "\\") {
          const e = source[i + 1];
          if (e === undefined) err("Unterminated string literal", start);
          if (!(e in ESCAPES)) err(`Invalid escape sequence \\${e}`, i);
          value += ESCAPES[e];
          i += 2;
          continue;
        }
        value += ch;
        i++;
      }
      tokens.push({ kind: "string", value, at: start });
      continue;
    }
    let m = /^[0-9]+/.exec(source.slice(i, i + 32));
    if (m) {
      tokens.push({ kind: "integer", value: m[0], at: i });
      i += m[0].length;
      continue;
    }
    m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i, i + 256));
    if (m) {
      const word = m[0];
      if (KEYWORDS.has(word)) tokens.push({ kind: word, at: i });
      else if (/^[A-Z]/.test(word)) tokens.push({ kind: "upper", value: word, at: i });
      else tokens.push({ kind: "name", value: word, at: i });
      i += word.length;
      continue;
    }
    err(`Invalid character ${JSON.stringify(String.fromCodePoint(source.codePointAt(i)))}`);
  }
  return tokens;
}

const node = {
  variable: (l) => ({ 0: "v", l }),
  lambda: (l, b) => ({ 0: "f", l, b }),
  apply: (f, a) => ({ 0: "a", f, a }),
  let: (l, v, t) => ({ 0: "l", l, v, t }),
  integer: (v) => ({ 0: "i", v }),
  string: (v) => ({ 0: "s", v }),
  tail: () => ({ 0: "ta" }),
  cons: () => ({ 0: "c" }),
  vacant: () => ({ 0: "z", c: "" }),
  empty: () => ({ 0: "u" }),
  extend: (l) => ({ 0: "e", l }),
  select: (l) => ({ 0: "g", l }),
  overwrite: (l) => ({ 0: "o", l }),
  tag: (l) => ({ 0: "t", l }),
  case: (l) => ({ 0: "m", l }),
  nocases: () => ({ 0: "n" }),
  perform: (l) => ({ 0: "p", l }),
  handle: (l) => ({ 0: "h", l }),
  builtin: (l) => ({ 0: "b", l }),
  reference: (l) => ({ 0: "#", l }),
};

export function parse(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (n = 0) => tokens[pos + n];
  const end = () => (tokens.length ? tokens[tokens.length - 1].at + 1 : 0);
  const fail = (message, token = peek()) => {
    throw new ParseError(token ? message : "Unexpected end of input", token ? token.at : end(), source);
  };
  const next = () => {
    const t = tokens[pos++];
    if (!t) fail("Unexpected end of input");
    return t;
  };
  const expect = (kind, message = `Expected ${kind}`) => {
    const t = peek();
    if (!t || t.kind !== kind) fail(message);
    pos++;
    return t;
  };

  function destructured(fields, body) {
    // Fields are applied so the first listed field is the outermost let.
    let out = body;
    for (let i = fields.length - 1; i >= 0; i--) {
      const [field, variable] = fields[i];
      out = node.let(variable, node.apply(node.select(field), node.variable("$")), out);
    }
    return out;
  }

  function pattern() {
    const t = next();
    if (t.kind === "name") return { assign: t.value };
    if (t.kind !== "{") fail("Expected a variable name or record pattern", t);
    const fields = [];
    for (;;) {
      const f = next();
      if (f.kind === "}") break;
      if (f.kind !== "name") fail("Expected a field name", f);
      let variable = f.value;
      if (peek()?.kind === ":") {
        pos++;
        variable = expect("name", "Expected a variable name").value;
      }
      fields.push([f.value, variable]);
      const sep = next();
      if (sep.kind === "}") break;
      if (sep.kind !== ",") fail("Expected , or }", sep);
    }
    return { fields };
  }

  const bind = (p, value, then) => (p.assign !== undefined ? node.let(p.assign, value, then) : node.let("$", value, destructured(p.fields, then)));
  const abstract = (p, body) => (p.assign !== undefined ? node.lambda(p.assign, body) : node.lambda("$", destructured(p.fields, body)));

  // A block allows a trailing let with no following expression.
  function block() {
    if (peek()?.kind !== "let") return expression();
    pos++;
    const p = pattern();
    expect("=", "Missing = in let binding");
    const value = expression();
    const then = pos < tokens.length && peek().kind !== "}" ? block() : node.vacant();
    return bind(p, value, then);
  }

  function expression() {
    const t = next();
    let exp;
    switch (t.kind) {
      case "todo":
        exp = node.vacant();
        break;
      case "name":
        exp = node.variable(t.value);
        break;
      case "let": {
        const p = pattern();
        expect("=", "Missing = in let binding");
        const value = expression();
        exp = bind(p, value, expression());
        break;
      }
      case "(": {
        const patterns = [];
        for (;;) {
          patterns.push(pattern());
          const sep = next();
          if (sep.kind === ")") break;
          if (sep.kind !== ",") fail("Expected , or )", sep);
        }
        expect("->", "Missing -> in function");
        const brace = expect("{", "Missing { after ->");
        const body = expression();
        if (peek()?.kind !== "}") throw new ParseError("Unclosed function body", brace.at, source);
        pos++;
        exp = body;
        for (let i = patterns.length - 1; i >= 0; i--) exp = abstract(patterns[i], exp);
        break;
      }
      case "integer":
        exp = node.integer(integer(t.value, t));
        break;
      case "-": {
        const n = expect("integer", "Expected an integer after -");
        exp = node.integer(-integer(n.value, n) || 0);
        break;
      }
      case "string":
        exp = node.string(t.value);
        break;
      case "[":
        exp = list();
        break;
      case "{":
        exp = record();
        break;
      case "upper":
        exp = node.tag(t.value);
        break;
      case "match": {
        if (peek()?.kind === "{") {
          pos++;
          exp = clauses();
        } else {
          const subject = expression();
          expect("{", "Expected { after match subject");
          exp = node.apply(clauses(), subject);
        }
        break;
      }
      case "perform":
        exp = node.perform(expect("upper", "perform must be followed by an uppercase effect name").value);
        break;
      case "handle":
        exp = node.handle(expect("upper", "handle must be followed by an uppercase effect name").value);
        break;
      case "!":
        exp = node.builtin(expect("name", "! must be followed by a builtin name").value);
        break;
      case "#":
        exp = node.reference(expect("name", "Expected a content identifier").value);
        break;
      case "@": {
        const name = expect("name", "Expected a package name").value;
        exp = { 0: "#", p: name, r: 0, l: "" };
        while (peek()?.kind === ":") pos += 2;
        break;
      }
      case "import":
        exp = { 0: "#", l: expect("string", "import must be followed by a string path").value, import: true };
        break;
      default:
        fail(`Unexpected ${t.kind}`, t);
    }
    return after(exp);
  }

  function after(exp) {
    for (;;) {
      const t = peek();
      if (t?.kind === "(") {
        pos++;
        const args = [expression()];
        for (;;) {
          const sep = next();
          if (sep.kind === ")") break;
          if (sep.kind !== ",") fail("Expected , or )", sep);
          args.push(expression());
        }
        for (const a of args) exp = node.apply(exp, a);
      } else if (t?.kind === "." && peek(1)?.kind === "name") {
        pos += 2;
        exp = node.apply(node.select(peek(-1).value), exp);
      } else return exp;
    }
  }

  function integer(raw, t) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) fail(`Integer literal ${raw} is out of range`, t);
    return n;
  }

  function list() {
    const items = [];
    let tail = node.tail();
    if (peek()?.kind === "]") {
      pos++;
    } else {
      for (;;) {
        items.push(expression());
        const sep = next();
        if (sep.kind === "]") break;
        if (sep.kind !== ",") fail("Expected , or ]", sep);
        if (peek()?.kind === "]") {
          pos++;
          break;
        }
        if (peek()?.kind === "..") {
          pos++;
          tail = expression();
          expect("]", "Expected ] after list spread");
          break;
        }
      }
    }
    let out = tail;
    for (let i = items.length - 1; i >= 0; i--) out = node.apply(node.apply(node.cons(), items[i]), out);
    return out;
  }

  function record() {
    const fields = [];
    for (;;) {
      const t = next();
      if (t.kind === "}") return build(fields, node.empty(), node.extend);
      if (t.kind === "..") {
        if (fields.length === 0) fail("A record update needs at least one field", t);
        const base = expression();
        expect("}", "Expected } after record update");
        return build(fields, base, node.overwrite);
      }
      if (t.kind !== "name") fail("Expected a field name", t);
      let value;
      if (peek()?.kind === ":") {
        pos++;
        value = expression();
      } else value = node.variable(t.value);
      fields.push([t.value, value]);
      const sep = peek();
      if (sep?.kind === ",") pos++;
      else if (sep?.kind !== "}") fail("Expected , or }", sep);
    }
  }

  function build(fields, base, op) {
    let out = base;
    for (let i = fields.length - 1; i >= 0; i--) out = node.apply(node.apply(op(fields[i][0]), fields[i][1]), out);
    return out;
  }

  function clauses() {
    const cases = [];
    let otherwise = node.nocases();
    for (;;) {
      const t = next();
      if (t.kind === "}") break;
      if (t.kind === "upper") {
        cases.push([t.value, expression()]);
        continue;
      }
      if (t.kind === "|") {
        otherwise = expression();
        expect("}", "Expected } after the else branch");
        break;
      }
      fail("Expected a tag, | or }", t);
    }
    let out = otherwise;
    for (let i = cases.length - 1; i >= 0; i--) out = node.apply(node.apply(node.case(cases[i][0]), cases[i][1]), out);
    return out;
  }

  if (tokens.length === 0) return node.vacant();
  const program = block();
  if (pos < tokens.length) fail("Unexpected trailing input");
  return program;
}
