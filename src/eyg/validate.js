// Static checks run before a program is accepted.
//
// EYG effects are named statically (`perform Label`), so collecting the
// labels in the IR gives an exact list of effects a program can ask the host
// for. A program that names an effect outside the allowed set is rejected
// before it ever runs. This is a syntactic approximation of EYG's effect
// types: it is sound for host effects, but it does not type-check values.

import { parse } from "./parser.js";
import { BUILTIN_NAMES } from "./interpreter.js";

export function analyse(ir) {
  const performs = new Set();
  const handles = new Set();
  const builtins = new Set();
  const references = [];
  let nodes = 0;
  const stack = [ir];
  while (stack.length) {
    const n = stack.pop();
    nodes++;
    switch (n["0"]) {
      case "p":
        performs.add(n.l);
        break;
      case "h":
      case "hs":
        handles.add(n.l);
        break;
      case "b":
        builtins.add(n.l);
        break;
      case "#":
        references.push(n.import ? `import "${n.l}"` : n.p ? `@${n.p}` : `#${n.l}`);
        break;
    }
    for (const k of ["f", "a", "b", "v", "t"]) {
      if (n[k] && typeof n[k] === "object" && "0" in n[k]) stack.push(n[k]);
    }
  }
  return { performs: [...performs].sort(), handles: [...handles].sort(), builtins: [...builtins].sort(), references, nodes };
}

// A program arrives either as text or as JSON IR (from the structural
// editor). Both end up as IR and go through the same checks.
//   check(source, options)
//   check({ir}, options)
// Returns {ok: true, ir, effects} or {ok: false, errors: [...]}.
export function check(program, { allowedEffects, maxSourceBytes = 65536, maxNodes = 20000 }) {
  let ir;
  if (typeof program === "string") {
    if (Buffer.byteLength(program, "utf8") > maxSourceBytes) return { ok: false, errors: [`Program is larger than ${maxSourceBytes} bytes`] };
    try {
      ir = parse(program);
    } catch (e) {
      return { ok: false, errors: [e.message] };
    }
  } else {
    ir = program.ir;
    const shape = validateShape(ir, maxNodes);
    if (shape.length) return { ok: false, errors: shape };
  }
  const info = analyse(ir);
  const errors = [];
  if (info.nodes > maxNodes) errors.push(`Program has ${info.nodes} nodes, the limit is ${maxNodes}`);
  for (const r of info.references) errors.push(`References are not available in this game: ${r}`);
  for (const b of info.builtins) if (!BUILTIN_NAMES.includes(b)) errors.push(`Unknown builtin !${b}`);
  for (const p of info.performs) if (!allowedEffects.includes(p)) errors.push(`Effect ${p} is not available; allowed effects are ${allowedEffects.join(", ")}`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, ir, effects: info.performs };
}

// The fields each IR node type must have, from the EYG spec. Values are
// "label", "node", "string", "integer", "bytes" or "any" (for references,
// which are rejected by the effect check with a clearer message).
const SHAPES = {
  v: { l: "label" },
  f: { l: "label", b: "node" },
  a: { f: "node", a: "node" },
  l: { l: "label", v: "node", t: "node" },
  x: { v: "bytes" },
  i: { v: "integer" },
  s: { v: "string" },
  ta: {},
  c: {},
  z: {},
  u: {},
  n: {},
  e: { l: "label" },
  g: { l: "label" },
  o: { l: "label" },
  t: { l: "label" },
  m: { l: "label" },
  p: { l: "label" },
  h: { l: "label" },
  b: { l: "label" },
  "#": {},
};

// Check untrusted JSON IR before anything else touches it.
export function validateShape(ir, maxNodes = 20000) {
  const errors = [];
  const stack = [[ir, "program"]];
  let count = 0;
  while (stack.length && errors.length < 5) {
    const [node, where] = stack.pop();
    if (++count > maxNodes) return [`Program has more than ${maxNodes} nodes`];
    if (!node || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(SHAPES, node["0"])) {
      errors.push(`${where} is not an EYG expression`);
      continue;
    }
    for (const [field, kind] of Object.entries(SHAPES[node["0"]])) {
      const value = node[field];
      const ok =
        kind === "node"
          ? value && typeof value === "object"
          : kind === "label"
            ? typeof value === "string" && value.length > 0 && !/\s/.test(value)
            : kind === "string"
              ? typeof value === "string"
              : kind === "integer"
                ? Number.isSafeInteger(value)
                : kind === "bytes"
                  ? typeof value?.["/"]?.bytes === "string"
                  : true;
      if (!ok) errors.push(`${where}: field "${field}" of a "${node["0"]}" node must be a ${kind}`);
      else if (kind === "node") stack.push([value, `${where}.${field}`]);
    }
    if (node["0"] === "z" && node.c !== undefined && typeof node.c !== "string") errors.push(`${where}: a vacant comment must be a string`);
  }
  return errors;
}
