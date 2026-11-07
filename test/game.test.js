import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Match, ProgramError, verify } from "../src/game/match.js";

const bot = (name) => readFileSync(new URL(`../bots/${name}.eyg`, import.meta.url), "utf8");
const FORAGER = bot("forager");
const RAIDER = bot("raider");
const logsOf = (match) => match.history.flatMap((f) => f.logs);

test("identical programs produce a mirror-image game and a draw", () => {
  for (const seed of [1, 2, 3]) {
    const match = new Match({ players: [{ name: "a", source: FORAGER }, { name: "b", source: FORAGER }], seed, rules: { maxTicks: 150 } });
    const { width: w, height: h } = match.rules;
    match.run((m) => {
      const side = (p, flip) =>
        m.bots
          .filter((b) => b.player === p)
          .map((b) => [b.local, flip ? w - 1 - b.x : b.x, flip ? h - 1 - b.y : b.y, b.hp, b.energy].join())
          .sort();
      assert.deepEqual(side(1, true), side(0, false), `asymmetry at tick ${m.tick}, seed ${seed}`);
    });
    assert.equal(match.result().draw, true);
  }
});

test("four identical players stay symmetric", () => {
  const players = ["a", "b", "c", "d"].map((name) => ({ name, source: FORAGER }));
  const match = new Match({ players, seed: 9, rules: { maxTicks: 80 } });
  match.run();
  const scores = match.result().scores.map((s) => [s.bots, s.energy].join());
  assert.equal(new Set(scores).size, 1, scores.join(" | "));
});

test("matches are deterministic and replays verify", () => {
  const players = [{ name: "forager", source: FORAGER }, { name: "raider", source: RAIDER }];
  const a = new Match({ players, seed: 4, rules: { maxTicks: 120 } });
  const b = new Match({ players, seed: 4, rules: { maxTicks: 120 } });
  a.run();
  b.run();
  assert.equal(a.hash, b.hash);
  const replay = JSON.parse(JSON.stringify(a.replay()));
  assert.equal(verify(replay).ok, true);

  const forged = structuredClone(replay);
  forged.result.winners = ["raider"];
  assert.equal(verify(forged).ok, false);

  const moved = structuredClone(replay);
  moved.frames[50].bots[0][5] += 5; // claim extra energy at tick 50
  assert.deepEqual(verify(moved), { ok: false, tick: 50 });

  const swapped = structuredClone(replay);
  swapped.players[1].source = FORAGER;
  assert.equal(verify(swapped).ok, false);
});

test("a match saved mid-game, with suspended programs, finishes identically", () => {
  const players = [{ name: "forager", source: FORAGER }, { name: "raider", source: RAIDER }];
  const whole = new Match({ players, seed: 11, rules: { maxTicks: 160 } });
  whole.run();

  const first = new Match({ players, seed: 11, rules: { maxTicks: 160 } });
  for (let i = 0; i < 70; i++) first.step();
  const resumed = Match.load(first.save());
  resumed.run();
  assert.equal(resumed.hash, whole.hash);
  assert.deepEqual(resumed.result(), whole.result());
});

test("programs asking for effects the game lacks are rejected before play", () => {
  for (const source of [`perform Teleport({x: 0, y: 0})`, `let lib = import "./lib.eyg"\nlib`, `!os_exec("ls")`]) {
    assert.throws(() => new Match({ players: [{ name: "cheat", source }, { name: "f", source: FORAGER }] }), ProgramError);
  }
});

test("an endless loop costs only its own turn", () => {
  const spinner = `!fix((self, n) -> { self(!int_add(n, 1)) })(0)`;
  const match = new Match({ players: [{ name: "spin", source: spinner }, { name: "forager", source: FORAGER }], seed: 2, rules: { maxTicks: 60 } });
  const started = Date.now();
  const result = match.run();
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual(result.winners, ["forager"]);
  assert.equal(result.scores[0].bots, 1);
});

test("a computation longer than one tick continues on the next tick", () => {
  const thinker = `
    let count = !fix((self, n) -> { match !int_compare(n, 500) { Lt(_) -> { self(!int_add(n, 1)) } | (_) -> { n } } })
    let r = perform Move(East({}))
    let done = count(0)
    perform Log(!int_to_string(done))`;
  const match = new Match({ players: [{ name: "thinker", source: thinker }, { name: "f", source: FORAGER }], seed: 3, rules: { maxTicks: 20 } });
  match.run();
  const logs = logsOf(match).filter((l) => l[0] === 0);
  assert.ok(logs.length >= 1 && logs.every((l) => l[2] === "500"), JSON.stringify(logs));
  // It spent several ticks counting, so it logged far fewer times than ticks.
  assert.ok(logs.length < 6);
});

test("runaway memory and string growth crash only the offending bot", () => {
  const hoarder = `!fix((self, l) -> { self([l, ..l]) })([])`;
  const bomb = `!fix((self, s) -> { self(!string_append(s, s)) })("ab")`;
  for (const [source, message] of [[hoarder, /state exceeded/], [bomb, /LimitExceeded/]]) {
    const match = new Match({ players: [{ name: "x", source }, { name: "f", source: FORAGER }], seed: 1, rules: { maxTicks: 30, maxStateSize: 2000 } });
    match.run();
    assert.match(logsOf(match).find((l) => l[0] === 0)[2], message);
  }
});

test("simultaneous moves into one cell both fail", () => {
  const mover = `
    let r = perform Move(East({}))
    let _ = perform Log(r)
    perform Wait({})`;
  const match = new Match({ players: [{ name: "a", source: mover }, { name: "b", source: mover }], seed: 1, rules: { maxTicks: 3 } });
  // Player b's East is the world's West. Put b two cells east of a.
  const [a, b] = match.bots;
  b.x = a.x + 2;
  b.y = a.y;
  match.step();
  match.step();
  assert.deepEqual(match.history[2].logs.map((l) => l[2]), ['Error("contested")', 'Error("contested")']);
  assert.deepEqual([a.x, b.x], [1, 3]);
});

test("attacks resolve simultaneously", () => {
  const fighter = `perform Attack(East({}))`;
  const match = new Match({ players: [{ name: "a", source: fighter }, { name: "b", source: fighter }], seed: 1 });
  const [a, b] = match.bots;
  b.x = a.x + 1;
  b.y = a.y;
  a.hp = b.hp = 1;
  match.step();
  assert.equal(match.bots.length, 0);
  assert.equal(match.result().draw, true);
});

test("look reports the world in the player's own frame", () => {
  const looker = `
    let v = perform Look({})
    let _ = perform Log(v.me)
    perform Wait({})`;
  const match = new Match({ players: [{ name: "a", source: looker }, { name: "b", source: looker }], seed: 1, rules: { maxTicks: 1 } });
  match.step();
  const logs = match.history[1].logs.map((l) => l[2]);
  assert.equal(logs[0], logs[1]);
  assert.match(logs[0], /x: 1, y: 1/);
});

test("programs sent as IR play, and replays keep IR the text syntax cannot express", () => {
  // A bare cons, partially applied, has no text form.
  const ir = { 0: "l", l: "push", v: { 0: "c" }, t: { 0: "a", f: { 0: "p", l: "Wait" }, a: { 0: "u" } } };
  const players = [{ name: "ir", ir }, { name: "text", source: FORAGER }];
  const match = new Match({ players, seed: 5, rules: { maxTicks: 30 } });
  match.run();
  const replay = JSON.parse(JSON.stringify(match.replay()));
  assert.deepEqual(Object.keys(replay.players[0]), ["name", "ir"]);
  assert.deepEqual(Object.keys(replay.players[1]), ["name", "source"]);
  assert.equal(verify(replay).ok, true);

  // IR that prints exactly is recorded as text.
  const printable = new Match({ players: [{ name: "a", ir: JSON.parse(JSON.stringify(match.players[1].ir)) }, players[1]], seed: 5, rules: { maxTicks: 5 } });
  assert.deepEqual(Object.keys(printable.replay().players[0]), ["name", "source"]);
});

test("malformed IR is rejected before play", () => {
  for (const ir of [{ 0: "a", f: { 0: "v", l: "x" } }, { 0: "i", v: 1.5 }, { 0: "constructor" }, { 0: "v", l: "two words" }]) {
    assert.throws(() => new Match({ players: [{ name: "bad", ir }, { name: "f", source: FORAGER }] }), ProgramError);
  }
});
