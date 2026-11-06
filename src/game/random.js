// Small deterministic PRNG (mulberry32) and seed mixing on 32-bit integers.
// Only integer arithmetic is used, so results are identical on every machine.

export function mix(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x85ebca6b);
      h ^= h >>> 13;
    }
    h = Math.imul(h ^ 0xff, 0xc2b2ae35);
  }
  h ^= h >>> 16;
  return h >>> 0;
}

// Returns [value in [0, 1), next state].
export function next(state) {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

export class Rng {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  float() {
    const [x, s] = next(this.state);
    this.state = s;
    return x;
  }
  int(n) {
    return Math.floor(this.float() * n);
  }
}
