import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "../src/eyg/parser.js";
import { print, PrintError } from "../src/eyg/print.js";
import { canonical } from "../src/game/match.js";

// The spec writes a vacant node with no comment as {"0": "z"}; the parser
// always includes the empty comment.
const normal = (ir) => JSON.parse(JSON.stringify(ir), (_k, v) => (typeof v === "object" && v?.["0"] === "z" ? { 0: "z", c: v.c ?? "" } : v));
const roundTrips = (ir) => canonical(parse(print(ir))) === canonical(normal(ir));

test("bots print and parse back to the same IR", () => {
  for (const file of readdirSync(new URL("../bots/", import.meta.url))) {
    const ir = parse(readFileSync(new URL(`../bots/${file}`, import.meta.url), "utf8"));
    assert.ok(roundTrips(ir), file);
  }
});

test("syntax forms print and parse back to the same IR", () => {
  const sources = [
    `let {name: first, age} = {name: "Bob", age: 25}\nfirst`,
    `({x, y: why}, z) -> { !int_add(x, why) }`,
    `[1, 2, ..rest]`,
    `{age: 31, ..person}`,
    `match x {\n  Ok(v) -> { v }\n  | (_) -> { -1 }\n}`,
    `match {\n  A(_) -> { 1 }\n}`,
    `"quote \\" slash \\\\ newline \\n tab \\t"`,
    `handle Ask((q, k) -> { k(q) }, (_) -> { perform Ask("a") })`,
    `let x = todo`,
    `f(let y = 1\n y, [])`,
    `a.b.c(1)(2)`,
  ];
  for (const source of sources) assert.ok(roundTrips(parse(source)), source);
});

test("spec programs print exactly or say why they cannot", () => {
  let printed = 0;
  for (const suite of ["core", "effects", "builtins"]) {
    for (const c of JSON.parse(readFileSync(new URL(`./spec/${suite}_suite.json`, import.meta.url)))) {
      if (JSON.stringify(c.source).includes('"x"')) continue; // binary literals have no text syntax
      try {
        assert.ok(roundTrips(c.source), c.name);
        printed++;
      } catch (e) {
        if (!(e instanceof PrintError)) throw e;
      }
    }
  }
  assert.ok(printed > 80, `only ${printed} spec programs printed`);
});
