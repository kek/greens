// Every number that affects play lives here, and the full rule set is
// recorded in each replay so a result can be checked against the rules it was
// played under.
export const DEFAULT_RULES = Object.freeze({
  width: 24, // even, so the map can be mirrored into four identical quadrants
  height: 24,
  maxTicks: 400,
  sight: 5, // Look shows cells within this Chebyshev distance
  stepBudget: 3000, // evaluation steps per bot per tick
  lookCost: 25, // extra steps charged for each Look
  maxStateSize: 20000, // approximate heap objects a bot may keep between ticks
  memoryCheckEvery: 8, // ticks between state-size checks for each bot
  maxStringLength: 1024,
  maxBots: 30, // per player
  maxHp: 3,
  startEnergy: 10,
  energyCap: 20,
  splitCost: 10,
  attackDamage: 1,
  patchMax: 12,
  regrowEvery: 5, // every N ticks each patch regrows one unit
  wallChance: 0.14,
  patchChance: 0.05,
  maxLogsPerTick: 8, // per player
  maxLogLength: 120,
  maxSourceBytes: 65536,
});

export const ACTIONS = ["Move", "Harvest", "Attack", "Split", "Wait"];
export const QUERIES = ["Look", "Random", "Log"];
export const EFFECTS = [...QUERIES, ...ACTIONS];
export const DIRECTIONS = { North: [0, -1], East: [1, 0], South: [0, 1], West: [-1, 0] };
