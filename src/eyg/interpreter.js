// A step-metered EYG interpreter.
//
// The machine follows the reference CEK interpreter in eyg-lang
// (packages/gleam_interpreter/src/eyg/interpreter/state.gleam): a control
// (expression or value), a scope and a stack of continuation frames. All
// machine state is plain data, so a suspended program can be serialized and
// resumed later (see snapshot.js).
//
// Every transition costs one step. Operations that do more host work in a
// single transition (deep equality, walking the stack to find a handler,
// building lists in a builtin) charge extra steps, so the budget bounds real
// work rather than just transitions.

import * as v from "./value.js";

export class EvalError extends Error {
  constructor(reason) {
    super(describe(reason));
    this.reason = reason;
  }
}

function describe(reason) {
  const [k, x] = Object.entries(reason)[0];
  return typeof x === "string" ? `${k}: ${x}` : `${k}: ${v.show(x)}`;
}

const fail = (reason) => {
  throw new EvalError(reason);
};

const ARITY = { cons: 2, extend: 2, overwrite: 2, select: 1, tag: 1, match: 3, nocases: 1, perform: 1, handle: 2, resume: 1 };

export const DEFAULT_LIMITS = Object.freeze({
  maxStringLength: Infinity,
  maxBinarySize: Infinity,
});

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const graphemes = (s) => Array.from(segmenter.segment(s), (x) => x.segment);

const push = (f, next) => ({ f, next });

export class Machine {
  // `program` is a JSON IR expression. Optional `state` restores a snapshot.
  constructor(program, { limits = DEFAULT_LIMITS, state } = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (state) {
      Object.assign(this, state);
    } else {
      this.isValue = false;
      this.control = program;
      this.scope = null;
      this.stack = null;
      this.steps = 0;
    }
  }

  state() {
    return { isValue: this.isValue, control: this.control, scope: this.scope, stack: this.stack, steps: this.steps };
  }

  // Run until the program finishes, performs an effect not handled inside the
  // program, fails, or `this.steps` reaches `limit`.
  //   {status: "done", value}
  //   {status: "effect", label, lift}   -> call resume(reply) to continue
  //   {status: "error", reason}         -> the machine cannot continue
  //   {status: "budget"}                -> call run again with a higher limit
  run(limit = Infinity) {
    try {
      while (this.steps < limit) {
        this.steps++;
        if (!this.isValue) {
          this.eval(this.control);
        } else if (this.stack === null) {
          return { status: "done", value: this.control };
        } else {
          const frame = this.stack.f;
          this.stack = this.stack.next;
          this.apply(this.control, frame);
        }
        if (this.yielded) {
          const y = this.yielded;
          this.yielded = undefined;
          return y;
        }
      }
      return { status: "budget" };
    } catch (e) {
      if (e instanceof EvalError) return { status: "error", reason: e.reason };
      if (e instanceof RangeError) return { status: "error", reason: { LimitExceeded: e.message } };
      throw e;
    }
  }

  resume(reply) {
    this.isValue = true;
    this.control = reply;
  }

  value(x) {
    this.isValue = true;
    this.control = x;
  }

  expression(node, scope) {
    this.isValue = false;
    this.control = node;
    this.scope = scope;
  }

  eval(node) {
    switch (node["0"]) {
      case "v": {
        for (let s = this.scope; s; s = s.up) {
          if (s.n === node.l) return this.value(s.v);
        }
        return fail({ UndefinedVariable: node.l });
      }
      case "f":
        return this.value({ t: "clo", p: node.l, b: node.b, s: this.scope });
      case "a":
        this.stack = push({ k: "arg", node: node.a, s: this.scope }, this.stack);
        return this.expression(node.f, this.scope);
      case "l":
        this.stack = push({ k: "assign", l: node.l, node: node.t, s: this.scope }, this.stack);
        return this.expression(node.v, this.scope);
      case "x":
        return this.value(new Uint8Array(Buffer.from(node.v["/"].bytes, "base64")));
      case "i":
        return this.value(node.v);
      case "s":
        return this.value(node.v);
      case "ta":
        return this.value(v.NIL);
      case "c":
        return this.value(v.partial({ k: "cons" }, []));
      case "z":
        return fail({ NotImplemented: node.c ?? "" });
      case "u":
        return this.value(v.UNIT);
      case "e":
        return this.value(v.partial({ k: "extend", l: node.l }, []));
      case "g":
        return this.value(v.partial({ k: "select", l: node.l }, []));
      case "o":
        return this.value(v.partial({ k: "overwrite", l: node.l }, []));
      case "t":
        return this.value(v.partial({ k: "tag", l: node.l }, []));
      case "m":
        return this.value(v.partial({ k: "match", l: node.l }, []));
      case "n":
        return this.value(v.partial({ k: "nocases" }, []));
      case "p":
        return this.value(v.partial({ k: "perform", l: node.l }, []));
      case "h":
        return this.value(v.partial({ k: "handle", l: node.l }, []));
      case "b":
        if (!BUILTINS[node.l] || node.l === "fixed") return fail({ UndefinedBuiltin: node.l });
        return this.value(v.partial({ k: "builtin", l: node.l }, []));
      case "#":
        return fail({ UndefinedReference: node.l });
      default:
        return fail({ UnknownNode: String(node["0"]) });
    }
  }

  apply(value, frame) {
    switch (frame.k) {
      case "assign":
        return this.expression(frame.node, { n: frame.l, v: value, up: frame.s });
      case "arg":
        this.stack = push({ k: "apply", fn: value, s: frame.s }, this.stack);
        return this.expression(frame.node, frame.s);
      case "apply":
        this.scope = frame.s;
        return this.call(frame.fn, value);
      case "callwith":
        this.scope = frame.s;
        return this.call(value, frame.v);
      case "delimit":
      case "trace":
        this.scope = frame.s;
        return this.value(value);
    }
  }

  // Restore the caller's scope when a function returns. Consecutive trace
  // frames collapse, so tail calls do not grow the stack.
  trace() {
    if (this.stack === null || this.stack.f.k !== "trace") {
      this.stack = push({ k: "trace", s: this.scope }, this.stack);
    }
  }

  call(f, arg) {
    if (typeof f !== "object" || f === null || f instanceof Uint8Array) return fail({ NotAFunction: f });
    if (f.t === "clo") {
      this.trace();
      return this.expression(f.b, { n: f.p, v: arg, up: f.s });
    }
    if (f.t !== "part") return fail({ NotAFunction: f });
    const s = f.s;
    const args = f.a.length ? [...f.a, arg] : [arg];
    if (s.k === "builtin") {
      const builtin = BUILTINS[s.l];
      if (args.length < builtin.arity) return this.value(v.partial(s, args));
      return builtin.fn(this, ...args);
    }
    if (args.length < ARITY[s.k]) return this.value(v.partial(s, args));
    switch (s.k) {
      case "cons":
        asList(args[1]);
        return this.value(v.cons(args[0], args[1]));
      case "extend": {
        const fields = Object.assign(Object.create(null), asRecord(args[1]).f);
        fields[s.l] = args[0];
        return this.value(v.record(fields));
      }
      case "overwrite": {
        const r = asRecord(args[1]);
        if (!(s.l in r.f)) return fail({ MissingField: s.l });
        const fields = Object.assign(Object.create(null), r.f);
        fields[s.l] = args[0];
        return this.value(v.record(fields));
      }
      case "select": {
        const r = asRecord(args[0]);
        if (!(s.l in r.f)) return fail({ MissingField: s.l });
        return this.value(r.f[s.l]);
      }
      case "tag":
        return this.value(v.tagged(s.l, args[0]));
      case "match": {
        const t = asTagged(args[2]);
        return t.l === s.l ? this.call(args[0], t.v) : this.call(args[1], args[2]);
      }
      case "nocases":
        return fail({ NoMatch: args[0] });
      case "perform":
        return this.perform(s.l, args[0]);
      case "handle":
        this.stack = push({ k: "delimit", l: s.l, h: args[0], s: this.scope }, this.stack);
        return this.call(args[1], v.UNIT);
      case "resume": {
        this.trace();
        let stack = this.stack;
        let count = 0;
        for (let fr = s.frames; fr; fr = fr.next) {
          stack = push(fr.f, stack);
          count++;
        }
        this.steps += count;
        this.stack = stack;
        this.scope = s.scope;
        return this.value(args[0]);
      }
    }
  }

  // Find the nearest handler for `label`. Frames between the perform and the
  // handler (and the handler itself, for deep handlers) become the
  // resumption. With no handler in the program the effect goes to the host.
  perform(label, lift) {
    let popped = null;
    let walked = 0;
    for (let k = this.stack; k; k = k.next) {
      walked++;
      popped = push(k.f, popped);
      if (k.f.k === "delimit" && k.f.l === label) {
        this.steps += walked;
        const resume = v.partial({ k: "resume", frames: popped, scope: this.scope }, []);
        const e = k.f.s;
        this.stack = push({ k: "callwith", v: lift, s: e }, push({ k: "callwith", v: resume, s: e }, k.next));
        this.scope = e;
        return this.value(k.f.h);
      }
    }
    this.steps += walked;
    this.yielded = { status: "effect", label, lift };
  }

  checkString(s) {
    if (s.length > this.limits.maxStringLength) throw new RangeError(`string longer than ${this.limits.maxStringLength}`);
    return s;
  }

  checkBinary(b) {
    if (b.length > this.limits.maxBinarySize) throw new RangeError(`binary larger than ${this.limits.maxBinarySize}`);
    return b;
  }
}

function asInteger(x) {
  if (typeof x !== "number") fail({ IncorrectTerm: { expected: "Integer", got: x } });
  return x;
}
function asString(x) {
  if (typeof x !== "string") fail({ IncorrectTerm: { expected: "String", got: x } });
  return x;
}
function asBinary(x) {
  if (!(x instanceof Uint8Array)) fail({ IncorrectTerm: { expected: "Binary", got: x } });
  return x;
}
function asList(x) {
  if (typeof x !== "object" || (x.t !== "nil" && x.t !== "cons")) fail({ IncorrectTerm: { expected: "List", got: x } });
  return x;
}
function asRecord(x) {
  if (typeof x !== "object" || x.t !== "rec") fail({ IncorrectTerm: { expected: "Record", got: x } });
  return x;
}
function asTagged(x) {
  if (typeof x !== "object" || x.t !== "tag") fail({ IncorrectTerm: { expected: "Tagged", got: x } });
  return x;
}

function safe(name, args, n) {
  if (!Number.isSafeInteger(n)) fail({ Unrepresentable: { builtin: name, args } });
  return n === 0 ? 0 : n; // normalise -0
}

const compare = (a, b) => (a < b ? v.tagged("Lt", v.UNIT) : a > b ? v.tagged("Gt", v.UNIT) : v.tagged("Eq", v.UNIT));

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return compare(a[i], b[i]);
  return compare(a.length, b.length);
}

const def = (arity, fn) => ({ arity, fn });
const pure = (arity, fn) => def(arity, (m, ...args) => m.value(fn(m, ...args)));

const BUILTINS = {
  equal: def(2, (m, a, b) => {
    const [eq, visited] = v.equal(a, b);
    m.steps += visited;
    m.value(v.bool(eq));
  }),
  fix: def(1, (m, builder) => m.call(builder, v.partial({ k: "builtin", l: "fixed" }, [builder]))),
  fixed: def(2, (m, builder, arg) => {
    m.stack = push({ k: "callwith", v: arg, s: m.scope }, m.stack);
    m.call(builder, v.partial({ k: "builtin", l: "fixed" }, [builder]));
  }),
  never: def(1, (_m, x) => fail({ IncorrectTerm: { expected: "Never", got: x } })),

  int_compare: pure(2, (_m, a, b) => compare(asInteger(a), asInteger(b))),
  int_add: pure(2, (_m, a, b) => safe("int_add", [a, b], asInteger(a) + asInteger(b))),
  int_subtract: pure(2, (_m, a, b) => safe("int_subtract", [a, b], asInteger(a) - asInteger(b))),
  int_multiply: pure(2, (_m, a, b) => safe("int_multiply", [a, b], asInteger(a) * asInteger(b))),
  int_divide: pure(2, (_m, a, b) => (asInteger(b) === 0 ? v.error(v.UNIT) : v.ok(safe("int_divide", [a, b], Math.trunc(asInteger(a) / b))))),
  int_absolute: pure(1, (_m, a) => Math.abs(asInteger(a))),
  int_parse: pure(1, (_m, s) => {
    if (!/^[-+]?[0-9]+$/.test(asString(s))) return v.error(v.UNIT);
    const n = Number(s);
    if (!Number.isSafeInteger(n)) fail({ Unrepresentable: { builtin: "int_parse", args: [s] } });
    return v.ok(n === 0 ? 0 : n);
  }),
  int_to_string: pure(1, (_m, a) => String(asInteger(a))),

  string_append: pure(2, (m, a, b) => m.checkString(asString(a) + asString(b))),
  string_split: pure(2, (m, s, sep) => {
    const parts = asString(sep) === "" ? graphemes(asString(s)) : asString(s).split(sep);
    m.steps += parts.length;
    const [head = "", ...tail] = parts;
    return v.recordOf({ head, tail: v.listOf(tail) });
  }),
  string_split_once: pure(2, (_m, s, sep) => {
    asString(s);
    if (asString(sep) === "") return v.ok(v.recordOf({ pre: "", post: s }));
    const i = s.indexOf(sep);
    if (i < 0) return v.error(v.UNIT);
    return v.ok(v.recordOf({ pre: s.slice(0, i), post: s.slice(i + sep.length) }));
  }),
  string_replace: def(3, (m, s, from, to) => {
    asString(s), asString(from), asString(to);
    let out;
    if (from === "") out = s === "" ? to : to + graphemes(s).join(to) + to;
    else out = s.split(from).join(to);
    m.value(m.checkString(out));
  }),
  string_uppercase: pure(1, (m, s) => m.checkString(asString(s).toUpperCase())),
  string_lowercase: pure(1, (m, s) => m.checkString(asString(s).toLowerCase())),
  string_starts_with: pure(2, (_m, s, p) => v.bool(asString(s).startsWith(asString(p)))),
  string_ends_with: pure(2, (_m, s, p) => v.bool(asString(s).endsWith(asString(p)))),
  string_length: pure(1, (_m, s) => graphemes(asString(s)).length),
  string_to_binary: pure(1, (m, s) => m.checkBinary(new Uint8Array(Buffer.from(asString(s), "utf8")))),
  string_from_binary: pure(1, (_m, b) => {
    try {
      return v.ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(asBinary(b)));
    } catch (e) {
      if (e instanceof EvalError) throw e;
      return v.error(v.UNIT);
    }
  }),

  binary_from_integers: pure(1, (m, list) => {
    const items = v.listToArray(asList(list));
    m.steps += items.length;
    for (const i of items) {
      if (!Number.isInteger(i) || i < 0 || i > 255) fail({ IncorrectTerm: { expected: "Byte", got: i } });
    }
    return m.checkBinary(Uint8Array.from(items));
  }),
  binary_size: pure(1, (_m, b) => asBinary(b).length),
  binary_concat: pure(2, (m, a, b) => {
    const out = new Uint8Array(asBinary(a).length + asBinary(b).length);
    out.set(a);
    out.set(b, a.length);
    return m.checkBinary(out);
  }),
  binary_compare: pure(2, (_m, a, b) => compareBytes(asBinary(a), asBinary(b))),
  binary_fold: def(3, (m, bytes, state, fn) => {
    if (asBinary(bytes).length === 0) return m.value(state);
    fold(m, "binary_fold", bytes[0], bytes.subarray(1), state, fn);
  }),

  list_pop: pure(1, (_m, list) => (asList(list).t === "nil" ? v.error(v.UNIT) : v.ok(v.recordOf({ head: list.h, tail: list.tl })))),
  list_fold: def(3, (m, list, state, fn) => {
    if (asList(list).t === "nil") return m.value(state);
    fold(m, "list_fold", list.h, list.tl, state, fn);
  }),
};

// fn(element)(state), then continue folding the rest with the new state.
function fold(m, name, element, rest, state, fn) {
  const s = m.scope;
  m.stack = push({ k: "callwith", v: fn, s }, m.stack);
  m.stack = push({ k: "apply", fn: v.partial({ k: "builtin", l: name }, [rest]), s }, m.stack);
  m.stack = push({ k: "callwith", v: state, s }, m.stack);
  m.call(fn, element);
}

export const BUILTIN_NAMES = Object.keys(BUILTINS).filter((n) => n !== "fixed");

// Convenience: evaluate to completion with a map of host effect handlers.
export function evaluate(program, { handlers = {}, limit = Infinity, limits } = {}) {
  const m = new Machine(program, { limits });
  for (;;) {
    const r = m.run(limit);
    if (r.status !== "effect") return r;
    const h = handlers[r.label];
    if (!h) return { status: "error", reason: { UnhandledEffect: { label: r.label, lift: r.lift } } };
    m.resume(h(r.lift));
  }
}
