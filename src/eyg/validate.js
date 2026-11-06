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

// Returns {ok: true, ir, effects} or {ok: false, errors: [...]}.
export function check(source, { allowedEffects, maxSourceBytes = 65536, maxNodes = 20000 }) {
  if (Buffer.byteLength(source, "utf8") > maxSourceBytes) return { ok: false, errors: [`Program is larger than ${maxSourceBytes} bytes`] };
  let ir;
  try {
    ir = parse(source);
  } catch (e) {
    return { ok: false, errors: [e.message] };
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
