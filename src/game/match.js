// A Greens match: the authoritative world plus one EYG machine per bot.
//
// Each tick every bot's program runs, in isolation, for at most
// `rules.stepBudget` evaluation steps. Queries (Look, Random, Log) are
// answered immediately. Actions (Move, Harvest, Attack, Split, Wait) end the
// bot's turn; all actions are then resolved together from the same
// start-of-tick world, so the order in which programs ran never matters.
// The reply to an action is the value `perform` returns at the start of the
// next tick.

import { createHash } from "node:crypto";
import { Machine } from "../eyg/interpreter.js";
import { check } from "../eyg/validate.js";
import { parse } from "../eyg/parser.js";
import { print, PrintError } from "../eyg/print.js";
import { indexPrograms, freeze, thaw, measure } from "../eyg/snapshot.js";
import * as v from "../eyg/value.js";
import { DEFAULT_RULES, EFFECTS, DIRECTIONS } from "./rules.js";
import { generate, frames, render, START, EMPTY, WALL, PATCH } from "./map.js";
import { mix, next as nextRandom } from "./random.js";

export const VERSION = 1;
const OK = v.ok(v.UNIT);
const err = (reason) => v.error(reason);
const ACTION_CODES = { Wait: 0, Move: 1, Harvest: 2, Attack: 3, Split: 4 };
const DIR_CODES = { North: 0, East: 1, South: 2, West: 3 };

export class Match {
  // players: [{name, source}] or [{name, ir}], 2 to 4 of them.
  constructor({ players, seed = 1, rules = {} }) {
    if (players.length < 2 || players.length > 4) throw new Error("A match needs 2 to 4 players");
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.seed = seed;
    this.players = players.map(({ name, source, ir }) => {
      const result = check(source ?? { ir }, { allowedEffects: EFFECTS, maxSourceBytes: this.rules.maxSourceBytes });
      if (!result.ok) throw new ProgramError(name, result.errors);
      return { name, source: source ?? textFor(result.ir), ir: result.ir };
    });
    this.index = indexPrograms(this.players.map((p) => p.ir));
    this.frames = frames(players.length);
    this.grid = generate(seed, this.rules);
    this.patches = new Map();
    this.grid.forEach((c, i) => c === PATCH && this.patches.set(i, this.rules.patchMax));
    this.tick = 0;
    this.nextId = 1;
    this.bots = [];
    this.locals = this.players.map(() => 0);
    this.hash = createHash("sha256").update(`greens:${VERSION}:${seed}:${JSON.stringify(this.rules)}`).digest("hex");
    this.history = [];
    this.players.forEach((_, p) => {
      const { x, y } = this.toWorld(p, START.x, START.y);
      this.spawn(p, x, y, this.rules.startEnergy, mix("bot", seed, "root"));
    });
    this.record([]);
  }

  // ---- coordinates -------------------------------------------------------

  toWorld(p, x, y) {
    const { fx, fy } = this.frames[p];
    return { x: fx ? this.rules.width - 1 - x : x, y: fy ? this.rules.height - 1 - y : y };
  }
  toLocal(p, x, y) {
    return this.toWorld(p, x, y); // the transform is its own inverse
  }
  worldDirection(p, name) {
    const [dx, dy] = DIRECTIONS[name];
    const { fx, fy } = this.frames[p];
    return [fx ? -dx : dx, fy ? -dy : dy];
  }
  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.rules.width && y < this.rules.height;
  }
  cell(x, y) {
    return this.grid[y * this.rules.width + x];
  }

  spawn(player, x, y, energy, seed) {
    const bot = {
      id: this.nextId++,
      player,
      local: ++this.locals[player],
      x,
      y,
      hp: this.rules.maxHp,
      energy,
      seed, // random state, derived from lineage so mirrored bots draw the same numbers
      children: 0,
      machine: null,
      reply: undefined,
    };
    this.bots.push(bot);
    return bot;
  }

  get over() {
    if (this.tick >= this.rules.maxTicks) return true;
    return new Set(this.bots.map((b) => b.player)).size <= 1;
  }

  // ---- running programs ----------------------------------------------------

  // Run one bot's program until it takes an action or exhausts its budget.
  // Returns the intent {action, dir?} or null for no action this tick.
  think(bot, logs) {
    const fresh = (steps = 0) => {
      const machine = new Machine(this.players[bot.player].ir, { limits: { maxStringLength: this.rules.maxStringLength } });
      machine.steps = steps;
      return machine;
    };
    if (!bot.machine) bot.machine = fresh();
    let m = bot.machine;
    if (bot.reply !== undefined) {
      m.resume(bot.reply);
      bot.reply = undefined;
    }
    const limit = m.steps + this.rules.stepBudget;
    const log = (message) => {
      if (logs.filter((l) => l[0] === bot.player).length < this.rules.maxLogsPerTick) {
        logs.push([bot.player, bot.local, message.slice(0, this.rules.maxLogLength)]);
      }
    };
    for (;;) {
      const r = m.run(limit);
      if (r.status === "budget") return this.checkMemory(bot, log, null);
      if (r.status === "done") {
        // A finished program starts again, within the same step budget.
        m = bot.machine = fresh(m.steps);
        continue;
      }
      if (r.status === "error") {
        log(`crashed: ${describe(r.reason)}`);
        bot.machine = null;
        return null;
      }
      const { label, lift } = r;
      switch (label) {
        case "Look":
          m.steps += this.rules.lookCost;
          m.resume(this.look(bot));
          continue;
        case "Random": {
          if (!Number.isSafeInteger(lift) || lift < 1) {
            m.resume(err("Random needs a positive integer"));
            continue;
          }
          const [x, s] = nextRandom(bot.seed);
          bot.seed = s;
          m.resume(Math.floor(x * lift));
          continue;
        }
        case "Log":
          log(typeof lift === "string" ? lift : v.show(lift));
          m.resume(v.UNIT);
          continue;
        case "Wait":
          bot.reply = OK;
          return this.checkMemory(bot, log, { action: "Wait" });
        default: {
          if (!(label in ACTION_CODES)) {
            log(`crashed: unknown effect ${label}`);
            bot.machine = null;
            return null;
          }
          const dir = lift && lift.t === "tag" && DIRECTIONS[lift.l] ? lift.l : null;
          if (!dir) {
            bot.reply = err(`${label} needs a direction: North, East, South or West`);
            return this.checkMemory(bot, log, null);
          }
          return this.checkMemory(bot, log, { action: label, dir });
        }
      }
    }
  }

  // Measuring a large state is costly, so each bot is measured every
  // `memoryCheckEvery` ticks. Growth between checks is bounded by the step
  // budget, because every step allocates at most a few objects.
  checkMemory(bot, log, intent) {
    if ((this.tick + bot.local) % this.rules.memoryCheckEvery !== 0) return intent;
    const size = measure(bot.machine.state(), this.index, this.rules.maxStateSize);
    if (size > this.rules.maxStateSize) {
      log(`crashed: program state exceeded ${this.rules.maxStateSize}`);
      bot.machine = null;
      bot.reply = undefined;
      return null;
    }
    return intent;
  }

  look(bot) {
    const { sight, width, height } = this.rules;
    const occupant = new Map(this.bots.map((b) => [b.y * width + b.x, b]));
    const cells = [];
    const me = this.toLocal(bot.player, bot.x, bot.y);
    // Iterate in the bot's own frame so mirrored bots see identical lists.
    for (let ly = me.y - sight; ly <= me.y + sight; ly++) {
      for (let lx = me.x - sight; lx <= me.x + sight; lx++) {
        const { x, y } = this.toWorld(bot.player, lx, ly);
        if (!this.inBounds(x, y) || (x === bot.x && y === bot.y)) continue;
        const i = y * width + x;
        const other = occupant.get(i);
        let what;
        if (other && other.player === bot.player) what = v.tagged("Ally", v.recordOf({ id: other.local, hp: other.hp, energy: other.energy }));
        else if (other) what = v.tagged("Enemy", v.recordOf({ hp: other.hp }));
        else if (this.grid[i] === WALL) what = v.tagged("Wall", v.UNIT);
        else if (this.grid[i] === PATCH) what = v.tagged("Patch", v.recordOf({ amount: this.patches.get(i) }));
        else continue;
        cells.push(v.recordOf({ x: lx, y: ly, what }));
      }
    }
    return v.recordOf({
      tick: this.tick,
      width,
      height,
      me: v.recordOf({ id: bot.local, x: me.x, y: me.y, hp: bot.hp, energy: bot.energy }),
      cells: v.listOf(cells),
    });
  }

  // ---- resolution -----------------------------------------------------------

  step() {
    if (this.over) return false;
    const logs = [];
    const intents = this.bots.map((b) => this.think(b, logs));
    const { width } = this.rules;
    const results = intents.map(() => null);
    const targetOf = (i) => {
      const b = this.bots[i];
      const [dx, dy] = this.worldDirection(b.player, intents[i].dir);
      return { x: b.x + dx, y: b.y + dy };
    };
    const at = new Map(this.bots.map((b, i) => [b.y * width + b.x, i]));

    // 1. Attacks hit whoever stood on the target cell at the start of the tick.
    const damage = new Map();
    intents.forEach((intent, i) => {
      if (intent?.action !== "Attack") return;
      const t = targetOf(i);
      const target = this.inBounds(t.x, t.y) ? at.get(t.y * width + t.x) : undefined;
      if (target === undefined) return (results[i] = err("no_target"));
      damage.set(target, (damage.get(target) ?? 0) + this.rules.attackDamage);
      results[i] = OK;
    });
    const dead = new Set();
    for (const [i, d] of damage) {
      this.bots[i].hp -= d;
      if (this.bots[i].hp <= 0) dead.add(i);
    }
    const alive = (i) => !dead.has(i);

    // 2. Harvesting. A patch that cannot give every harvester a unit gives none.
    const harvesters = new Map();
    intents.forEach((intent, i) => {
      if (intent?.action !== "Harvest" || !alive(i)) return;
      const t = targetOf(i);
      const ci = t.y * width + t.x;
      if (!this.inBounds(t.x, t.y) || this.grid[ci] !== PATCH) return (results[i] = err("no_patch"));
      if (this.bots[i].energy >= this.rules.energyCap) return (results[i] = err("full"));
      if (!harvesters.has(ci)) harvesters.set(ci, []);
      harvesters.get(ci).push(i);
    });
    for (const [ci, list] of harvesters) {
      const amount = this.patches.get(ci);
      if (amount >= list.length) {
        this.patches.set(ci, amount - list.length);
        for (const i of list) {
          this.bots[i].energy++;
          results[i] = OK;
        }
      } else {
        for (const i of list) results[i] = err(amount === 0 ? "empty" : "contested");
      }
    }

    // 3. Moves and splits claim a cell. A claim succeeds only if the cell was
    //    free after attacks and nobody else claimed it.
    const claims = new Map();
    const occupied = new Set(this.bots.filter((_, i) => alive(i)).map((b) => b.y * width + b.x));
    const splitters = this.players.map(() => 0);
    intents.forEach((intent, i) => {
      if ((intent?.action !== "Move" && intent?.action !== "Split") || !alive(i)) return;
      const b = this.bots[i];
      if (intent.action === "Split" && b.energy < this.rules.splitCost) return (results[i] = err("not_enough_energy"));
      const t = targetOf(i);
      const ci = t.y * width + t.x;
      if (!this.inBounds(t.x, t.y) || this.grid[ci] !== EMPTY || occupied.has(ci)) return (results[i] = err("blocked"));
      if (!claims.has(ci)) claims.set(ci, []);
      claims.get(ci).push(i);
    });
    const born = [];
    for (const [ci, list] of claims) {
      if (list.length > 1) {
        for (const i of list) results[i] = err("contested");
        continue;
      }
      const i = list[0];
      const b = this.bots[i];
      if (intents[i].action === "Move") {
        b.x = ci % width;
        b.y = (ci / width) | 0;
        results[i] = OK;
      } else born.push([i, ci]);
    }
    // Children are numbered in parent order within each player, which is the
    // same in every player's frame.
    born.sort((a, b) => this.bots[a[0]].local - this.bots[b[0]].local);
    const children = [];
    for (const [i, ci] of born) {
      const b = this.bots[i];
      const team = this.bots.filter((x, j) => alive(j) && x.player === b.player).length + splitters[b.player];
      if (team >= this.rules.maxBots) {
        results[i] = err("team_full");
        continue;
      }
      splitters[b.player]++;
      b.energy -= this.rules.splitCost;
      b.children++;
      children.push([b.player, ci % width, (ci / width) | 0, mix("bot", b.seed, b.children)]);
      results[i] = OK;
    }

    intents.forEach((intent, i) => {
      if (intent && intent.action !== "Wait" && alive(i)) this.bots[i].reply = results[i] ?? OK;
    });
    const summary = intents.map((intent, i) => [intent ? ACTION_CODES[intent.action] : -1, intent?.dir ? DIR_CODES[intent.dir] : -1, results[i] && results[i].l === "Error" ? 0 : 1]);
    const deaths = this.bots.filter((_, i) => dead.has(i)).map((b) => b.id);
    this.lastActions = new Map(this.bots.map((b, i) => [b.id, summary[i]]));
    this.bots = this.bots.filter((_, i) => alive(i));
    for (const [player, x, y, seed] of children) this.spawn(player, x, y, 0, seed);

    this.tick++;
    if (this.tick % this.rules.regrowEvery === 0) {
      for (const [ci, amount] of this.patches) this.patches.set(ci, Math.min(this.rules.patchMax, amount + 1));
    }
    this.record(logs, deaths);
    return true;
  }

  run(onTick) {
    while (this.step()) onTick?.(this);
    return this.result();
  }

  // ---- results, replays and hashing ---------------------------------------

  worldState() {
    return {
      tick: this.tick,
      bots: this.bots.map((b) => [b.id, b.player, b.local, b.x, b.y, b.hp, b.energy]),
      patches: [...this.patches.values()],
    };
  }

  record(logs, deaths = []) {
    const state = this.worldState();
    this.hash = createHash("sha256").update(this.hash).update(JSON.stringify(state)).digest("hex");
    this.history.push({
      tick: this.tick,
      hash: this.hash,
      bots: this.bots.map((b) => [b.id, b.player, b.x, b.y, b.hp, b.energy, ...(this.lastActions?.get(b.id) ?? [-1, -1, 1])]),
      patches: state.patches,
      deaths,
      logs,
    });
  }

  scores() {
    return this.players.map((p, i) => {
      const team = this.bots.filter((b) => b.player === i);
      return { name: p.name, bots: team.length, energy: team.reduce((s, b) => s + b.energy, 0) };
    });
  }

  result() {
    const scores = this.scores();
    const best = (s) => [s.bots, s.energy];
    let winners = [0];
    for (let i = 1; i < scores.length; i++) {
      const [a, b] = [best(scores[i]), best(scores[winners[0]])];
      const cmp = a[0] - b[0] || a[1] - b[1];
      if (cmp > 0) winners = [i];
      else if (cmp === 0) winners.push(i);
    }
    return {
      over: this.over,
      tick: this.tick,
      scores,
      winners: winners.length === scores.length ? [] : winners.map((i) => scores[i].name),
      draw: winners.length > 1,
      hash: this.hash,
    };
  }

  replay() {
    return {
      game: "greens",
      version: VERSION,
      seed: this.seed,
      rules: this.rules,
      players: this.players.map(recordProgram),
      map: render(this.grid, this.rules.width),
      patchCells: [...this.patches.keys()],
      frames: this.history,
      result: this.result(),
    };
  }

  // ---- persistence -----------------------------------------------------------

  // Everything needed to continue this match elsewhere, including every
  // bot's suspended program, as JSON.
  save() {
    const bots = this.bots.map((b) => ({ ...b, machine: b.machine ? b.machine.state() : null }));
    const heap = freeze({ bots, patches: [...this.patches], locals: this.locals }, this.index);
    return JSON.stringify({
      game: "greens",
      version: VERSION,
      seed: this.seed,
      rules: this.rules,
      players: this.players.map(recordProgram),
      tick: this.tick,
      nextId: this.nextId,
      hash: this.hash,
      history: this.history,
      lastActions: this.lastActions ? [...this.lastActions] : null,
      heap,
    });
  }

  static load(json) {
    const s = JSON.parse(json);
    if (s.game !== "greens" || s.version !== VERSION) throw new Error("Not a Greens save for this version");
    const match = new Match({ players: s.players, seed: s.seed, rules: s.rules });
    const heap = thaw(s.heap, match.index);
    const limits = { maxStringLength: match.rules.maxStringLength };
    match.bots = heap.bots.map((b) => ({ ...b, machine: b.machine ? new Machine(null, { limits, state: b.machine }) : null }));
    match.patches = new Map(heap.patches);
    match.locals = heap.locals;
    match.tick = s.tick;
    match.nextId = s.nextId;
    match.hash = s.hash;
    match.history = s.history;
    match.lastActions = s.lastActions ? new Map(s.lastActions) : undefined;
    return match;
  }
}

// Replays and saves record a program as text when the text parses back to
// exactly the same IR, which is the usual case and much smaller, and as IR
// otherwise.
function recordProgram({ name, source, ir }) {
  return source !== null ? { name, source } : { name, ir };
}

function textFor(ir) {
  try {
    const text = print(ir);
    return canonical(parse(text)) === canonical(ir) ? text : null;
  } catch (e) {
    if (e instanceof PrintError) return null;
    throw e;
  }
}

export function canonical(x) {
  return JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

export class ProgramError extends Error {
  constructor(player, errors) {
    super(`${player}: ${errors.join("; ")}`);
    this.player = player;
    this.errors = errors;
  }
}

function describe(reason) {
  const [k, x] = Object.entries(reason)[0];
  if (typeof x === "string") return `${k} ${x}`;
  if (x && typeof x === "object" && "expected" in x) return `${k}: expected ${x.expected}, got ${v.show(x.got)}`;
  if (x && typeof x === "object" && "label" in x) return `${k} ${x.label}`;
  return `${k} ${v.show(x)}`;
}

// Re-run a replay from its programs, seed and rules and compare every
// recorded frame, including its chained state hash. Returns {ok, tick?},
// where tick is the first divergence.
export function verify(replay) {
  const match = new Match({ players: replay.players, seed: replay.seed, rules: replay.rules });
  const frames = replay.frames;
  if (JSON.stringify(frames[0]) !== JSON.stringify(match.history[0])) return { ok: false, tick: 0 };
  for (let t = 1; t < frames.length; t++) {
    match.step();
    if (JSON.stringify(match.history[t]) !== JSON.stringify(frames[t])) return { ok: false, tick: t };
  }
  if (match.history.length !== frames.length) return { ok: false, tick: frames.length };
  const result = match.result();
  if (JSON.stringify(result) !== JSON.stringify(replay.result)) return { ok: false, tick: frames.length - 1, reason: "result differs" };
  return { ok: true, result };
}
