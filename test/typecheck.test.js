import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "../src/eyg/parser.js";
import { typeErrors } from "../src/eyg/typecheck.js";

test("the example bots type check against the Greens effects", () => {
  for (const file of readdirSync(new URL("../bots/", import.meta.url))) {
    assert.deepEqual(typeErrors(parse(readFileSync(new URL(`../bots/${file}`, import.meta.url), "utf8"))), [], file);
  }
});

test("mistakes against the game's effects are type errors", () => {
  const errors = (source) => typeErrors(parse(source));
  assert.match(errors(`perform Move(Up({}))`)[0], /missing row 'Up'/);
  assert.equal(errors(`let v = perform Look({})\nv.me.mana`).length, 1);
  assert.equal(errors(`perform Random("six")`).length, 1);
  assert.equal(errors(`perform Teleport({})`).length, 1);
  assert.deepEqual(errors(`let v = perform Look({})\nperform Attack(match !int_compare(v.me.hp, 1) { Gt(_) -> { North({}) } | (_) -> { South({}) } })`), []);
});
