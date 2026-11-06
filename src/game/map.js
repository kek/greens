// Map generation. One quadrant is generated from the seed and mirrored into
// the other three, so every player starts in a corner of an identical world.
import { Rng, mix } from "./random.js";

export const EMPTY = 0;
export const WALL = 1;
export const PATCH = 2;

// Player frames: how each player's own coordinates map onto the world. Every
// player sees the world as if they started in the north-west corner.
export function frames(players) {
  if (players === 2) return [{ fx: false, fy: false }, { fx: true, fy: true }];
  return [{ fx: false, fy: false }, { fx: true, fy: true }, { fx: true, fy: false }, { fx: false, fy: true }].slice(0, players);
}

export const START = Object.freeze({ x: 1, y: 1 });

export function generate(seed, rules) {
  const { width: w, height: h } = rules;
  if (w % 2 || h % 2) throw new Error("Map width and height must be even");
  const rng = new Rng(mix("map", seed));
  for (let attempt = 0; attempt < 200; attempt++) {
    const grid = new Uint8Array(w * h);
    for (let y = 0; y < h / 2; y++) {
      for (let x = 0; x < w / 2; x++) {
        const r = rng.float();
        const nearStart = Math.abs(x - START.x) <= 2 && Math.abs(y - START.y) <= 2;
        const cell = nearStart ? EMPTY : r < rules.wallChance ? WALL : r < rules.wallChance + rules.patchChance ? PATCH : EMPTY;
        for (const [mx, my] of [[x, y], [w - 1 - x, y], [x, h - 1 - y], [w - 1 - x, h - 1 - y]]) grid[my * w + mx] = cell;
      }
    }
    // A guaranteed patch near each start.
    for (const [mx, my] of [[4, 3], [w - 5, 3], [4, h - 4], [w - 5, h - 4]]) grid[my * w + mx] = PATCH;
    if (connected(grid, w, h)) return grid;
  }
  throw new Error("Could not generate a connected map");
}

// Every start corner reachable from the first, and every patch next to a
// reachable cell.
function connected(grid, w, h) {
  const seen = new Uint8Array(w * h);
  const queue = [START.y * w + START.x];
  seen[queue[0]] = 1;
  while (queue.length) {
    const i = queue.pop();
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!seen[j] && grid[j] === EMPTY) {
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  const starts = [[START.x, START.y], [w - 1 - START.x, START.y], [START.x, h - 1 - START.y], [w - 1 - START.x, h - 1 - START.y]];
  if (!starts.every(([x, y]) => seen[y * w + x])) return false;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== PATCH) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const reachable = [[0, 1], [1, 0], [0, -1], [-1, 0]].some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < w && ny < h && seen[ny * w + nx];
    });
    if (!reachable) return false;
  }
  return true;
}

export function render(grid, w) {
  const rows = [];
  for (let i = 0; i < grid.length; i += w) {
    rows.push(Array.from(grid.subarray(i, i + w), (c) => (c === WALL ? "#" : c === PATCH ? "*" : ".")).join(""));
  }
  return rows;
}
