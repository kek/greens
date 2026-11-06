// Serialize arbitrary machine state (continuations, closures, values) to JSON.
//
// Values are immutable and heavily shared, so the encoding is a graph: every
// object appears once in a table and is referenced by index. That keeps
// snapshots linear in the number of distinct objects, even for programs that
// build exponentially shared structures. Program IR nodes are not copied;
// they are referenced by [program, node] index, and the same programs must be
// supplied when thawing.

export function indexPrograms(programs) {
  const byNode = new Map();
  const nodes = programs.map((ir, p) => {
    const list = [];
    const stack = [ir];
    while (stack.length) {
      const n = stack.pop();
      if (byNode.has(n)) continue;
      byNode.set(n, [p, list.length]);
      list.push(n);
      for (const k of ["f", "a", "b", "v", "t"]) {
        if (n[k] && typeof n[k] === "object" && "0" in n[k]) stack.push(n[k]);
      }
    }
    return list;
  });
  return { byNode, nodes };
}

export function freeze(root, index) {
  const ids = new Map();
  const table = [];
  const ref = (x) => {
    if (x === null || typeof x !== "object") return x === undefined ? { u: 1 } : x;
    const ir = index.byNode.get(x);
    if (ir) return { ir };
    let id = ids.get(x);
    if (id === undefined) {
      id = table.length;
      ids.set(x, id);
      table.push(x);
    }
    return { r: id };
  };
  const top = ref(root);
  for (let i = 0; i < table.length; i++) {
    const x = table[i];
    if (x instanceof Uint8Array) table[i] = { bin: Buffer.from(x).toString("base64") };
    else if (Array.isArray(x)) table[i] = { arr: x.map(ref) };
    else {
      const obj = {};
      for (const k of Object.keys(x)) obj[k] = ref(x[k]);
      table[i] = Object.getPrototypeOf(x) === null ? { dict: obj } : { obj };
    }
  }
  return { root: top, table };
}

export function thaw({ root, table }, index) {
  const objects = table.map((e) => (e.bin !== undefined ? new Uint8Array(Buffer.from(e.bin, "base64")) : e.arr ? [] : e.dict ? Object.create(null) : {}));
  const val = (x) => {
    if (x === null || typeof x !== "object") return x;
    if (x.u) return undefined;
    if (x.ir) return index.nodes[x.ir[0]][x.ir[1]];
    return objects[x.r];
  };
  table.forEach((e, i) => {
    const o = objects[i];
    if (e.arr) e.arr.forEach((x) => o.push(val(x)));
    else if (e.obj || e.dict) for (const [k, x] of Object.entries(e.obj || e.dict)) o[k] = val(x);
  });
  return val(root);
}

// Approximate the size of the state reachable from `root` in units of one
// heap object, stopping once `limit` is passed. Long strings and binaries
// count one unit per 64 characters or bytes. IR nodes belong to the program,
// not the state, and are not counted.
export function measure(root, index, limit) {
  const seen = new Set();
  const stack = [root];
  let size = 0;
  while (stack.length && size <= limit) {
    const x = stack.pop();
    if (typeof x === "string") {
      size += x.length >> 6;
      continue;
    }
    if (x === null || typeof x !== "object" || seen.has(x) || index.byNode.has(x)) continue;
    seen.add(x);
    size++;
    if (x instanceof Uint8Array) {
      size += x.length >> 6;
      continue;
    }
    for (const k in x) stack.push(x[k]);
  }
  return size;
}
