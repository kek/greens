// Runs the upstream EYG evaluation suites (copied from eyg-lang/spec) against
// this interpreter. See test/spec/NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Machine } from "../src/eyg/interpreter.js";
import { toSpec, fromSpec } from "../src/eyg/value.js";

for (const suite of ["core", "effects", "builtins"]) {
  const cases = JSON.parse(readFileSync(new URL(`./spec/${suite}_suite.json`, import.meta.url)));
  for (const c of cases) {
    test(`${suite}: ${c.name}`, () => {
      const m = new Machine(c.source);
      const effects = [...(c.effects ?? [])];
      let r;
      for (;;) {
        r = m.run();
        if (r.status !== "effect") break;
        const expected = effects.shift();
        assert.ok(expected, `unexpected effect ${r.label}`);
        assert.equal(r.label, expected.label);
        assert.deepEqual(toSpec(r.lift), expected.lift);
        m.resume(fromSpec(expected.reply));
      }
      assert.equal(effects.length, 0, "not all expected effects were performed");
      if (c.break) {
        assert.equal(r.status, "error");
        assert.deepEqual(r.reason, c.break);
      } else {
        assert.equal(r.status, "done", JSON.stringify(r.reason));
        assert.deepEqual(toSpec(r.value), c.value);
      }
    });
  }
}
