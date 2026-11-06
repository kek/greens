// EYG runtime values.
//
// Integers are JS numbers restricted to the safe-integer range, strings are JS
// strings and binaries are Uint8Arrays. Everything else is a plain object
// tagged by `t`. Values are never mutated after construction, so they can be
// shared freely between a continuation and its resumptions.

export const NIL = Object.freeze({ t: "nil" });
export const UNIT = Object.freeze({ t: "rec", f: Object.freeze(Object.create(null)) });

export const cons = (h, tl) => ({ t: "cons", h, tl });
export const tagged = (l, v) => ({ t: "tag", l, v });
export const partial = (s, a) => ({ t: "part", s, a });
export const record = (fields) => ({ t: "rec", f: fields });

export const TRUE = tagged("True", UNIT);
export const FALSE = tagged("False", UNIT);
export const bool = (b) => (b ? TRUE : FALSE);
export const ok = (v) => tagged("Ok", v);
export const error = (v) => tagged("Error", v);

export function recordOf(entries) {
  const f = Object.create(null);
  for (const [k, v] of Object.entries(entries)) f[k] = v;
  return record(f);
}

export function listOf(items) {
  let out = NIL;
  for (let i = items.length - 1; i >= 0; i--) out = cons(items[i], out);
  return out;
}

export function listToArray(list) {
  const out = [];
  while (list.t === "cons") {
    out.push(list.h);
    list = list.tl;
  }
  return out;
}

export function kindOf(v) {
  if (typeof v === "number") return "Integer";
  if (typeof v === "string") return "String";
  if (v instanceof Uint8Array) return "Binary";
  switch (v.t) {
    case "nil":
    case "cons":
      return "List";
    case "rec":
      return "Record";
    case "tag":
      return "Tagged";
    default:
      return "Function";
  }
}

// Structural equality. Returns [equal, nodesVisited] so callers can charge
// evaluation steps proportional to the work done.
export function equal(a, b) {
  let visited = 0;
  const stack = [[a, b]];
  while (stack.length) {
    const [x, y] = stack.pop();
    visited++;
    if (x === y) continue;
    if (typeof x !== "object" || typeof y !== "object") return [false, visited];
    if (x instanceof Uint8Array || y instanceof Uint8Array) {
      if (!(x instanceof Uint8Array && y instanceof Uint8Array) || x.length !== y.length) return [false, visited];
      visited += x.length;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return [false, visited];
      continue;
    }
    if (x.t !== y.t) return [false, visited];
    switch (x.t) {
      case "nil":
        continue;
      case "cons":
        stack.push([x.tl, y.tl], [x.h, y.h]);
        continue;
      case "tag":
        if (x.l !== y.l) return [false, visited];
        stack.push([x.v, y.v]);
        continue;
      case "rec": {
        const kx = Object.keys(x.f);
        if (kx.length !== Object.keys(y.f).length) return [false, visited];
        for (const k of kx) {
          if (!(k in y.f)) return [false, visited];
          stack.push([x.f[k], y.f[k]]);
        }
        continue;
      }
      default:
        // Functions compare by identity only.
        return [false, visited];
    }
  }
  return [true, visited];
}

// Encoding used by the EYG spec suites: {integer}, {string}, {list}, ...
export function toSpec(v) {
  if (typeof v === "number") return { integer: v };
  if (typeof v === "string") return { string: v };
  if (v instanceof Uint8Array) return { binary: { "/": { bytes: Buffer.from(v).toString("base64").replace(/=+$/, "") } } };
  switch (v.t) {
    case "nil":
    case "cons":
      return { list: listToArray(v).map(toSpec) };
    case "rec": {
      const out = {};
      for (const k of Object.keys(v.f).sort()) out[k] = toSpec(v.f[k]);
      return { record: out };
    }
    case "tag":
      return { tagged: { label: v.l, value: toSpec(v.v) } };
    default:
      return { function: true };
  }
}

export function fromSpec(s) {
  if ("integer" in s) return s.integer;
  if ("string" in s) return s.string;
  if ("binary" in s) return new Uint8Array(Buffer.from(s.binary["/"].bytes, "base64"));
  if ("list" in s) return listOf(s.list.map(fromSpec));
  if ("record" in s) {
    const f = Object.create(null);
    for (const [k, x] of Object.entries(s.record)) f[k] = fromSpec(x);
    return record(f);
  }
  if ("tagged" in s) return tagged(s.tagged.label, fromSpec(s.tagged.value));
  throw new Error("Unsupported spec value " + JSON.stringify(s));
}

// Human readable rendering, used in logs and error messages.
export function show(v, depth = 0) {
  if (depth > 6) return "…";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  switch (v.t) {
    case "nil":
    case "cons": {
      const items = listToArray(v);
      const shown = items.slice(0, 8).map((x) => show(x, depth + 1));
      if (items.length > 8) shown.push("…");
      return `[${shown.join(", ")}]`;
    }
    case "rec":
      return `{${Object.keys(v.f).map((k) => `${k}: ${show(v.f[k], depth + 1)}`).join(", ")}}`;
    case "tag":
      return `${v.l}(${show(v.v, depth + 1)})`;
    default:
      return "<function>";
  }
}
