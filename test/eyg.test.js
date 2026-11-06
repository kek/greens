import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, ParseError } from "../src/eyg/parser.js";
import { Machine, evaluate } from "../src/eyg/interpreter.js";
import { toSpec, show } from "../src/eyg/value.js";
import { indexPrograms, freeze, thaw, measure } from "../src/eyg/snapshot.js";
import { check } from "../src/eyg/validate.js";

const run = (source, handlers) => {
  const r = evaluate(parse(source), { handlers });
  assert.equal(r.status, "done", JSON.stringify(r.reason));
  return r.value;
};

test("syntax guide examples evaluate", () => {
  assert.equal(
    run(`
      let factorial = !fix((self, n) -> {
        match !int_compare(n, 0) {
          Eq(_) -> { 1 }
          | (_) -> { !int_multiply(n, self(!int_subtract(n, 1))) }
        }
      })
      factorial(5)`),
    120,
  );
  assert.equal(run(`let {name: first, age: n} = {name: "Bob", age: 25, admin: True({})}\nfirst`), "Bob");
  assert.equal(run(`let {name, age} = {name: "Al", age: 3}\nage`), 3);
  assert.deepEqual(toSpec(run(`let rest = [2, 3]\n[1, ..rest]`)), { list: [{ integer: 1 }, { integer: 2 }, { integer: 3 }] });
  assert.deepEqual(toSpec(run(`{age: 31, ..{name: "A", age: 30}}`)), { record: { age: { integer: 31 }, name: { string: "A" } } });
  assert.equal(run(`match Ok(5) {\n Ok(n) -> { n }\n Error(_) -> { 0 }\n}`), 5);
  assert.equal(run(`let f = match {\n Ok(v) -> { v }\n | (_) -> { -1 }\n}\nf(Error({}))`), -1);
  assert.equal(run(`"she said \\"hi\\"\\n"`), 'she said "hi"\n');
  assert.equal(run(`let add = (x, y) -> { !int_add(x, y) }\nadd(3, 4)`), 7);
  assert.equal(run(`// comment\nlet x = 5\nlet y = -7\n!int_add(x, y)`), -2);
  assert.equal(run(`["a", "b",]`).tl.h, "b");
});

test("record and select parse to the IR from the spec", () => {
  assert.deepEqual(parse(`{a: 1}.a`), {
    0: "a",
    f: { 0: "g", l: "a" },
    a: { 0: "a", f: { 0: "a", f: { 0: "e", l: "a" }, a: { 0: "i", v: 1 } }, a: { 0: "u" } },
  });
  assert.deepEqual(parse(`let x = 1`), { 0: "l", l: "x", v: { 0: "i", v: 1 }, t: { 0: "z", c: "" } });
});

test("effects handled in the program and by the host", () => {
  const logs = [];
  const value = run(
    `
    let collect = handle Ask((question, resume) -> { resume(!string_append(question, "!")) })
    let answer = collect((_) -> { perform Ask("why") })
    let _ = perform Log(answer)
    answer`,
    { Log: (x) => (logs.push(x), { t: "rec", f: Object.create(null) }) },
  );
  assert.equal(value, "why!");
  assert.deepEqual(logs, ["why!"]);
});

test("parse errors report line and column", () => {
  assert.throws(() => parse("let x = 1\nlet y = = 2"), (e) => e instanceof ParseError && e.line === 2 && e.column === 9);
  assert.throws(() => parse('"open'), /Unterminated string/);
  assert.throws(() => parse("1 + 2"), /Invalid character/);
  assert.throws(() => parse("99999999999999999999"), /out of range/);
});

test("the step budget suspends a program and it resumes where it stopped", () => {
  const ir = parse(`
    let count = !fix((self, n) -> {
      match !int_compare(n, 10000) { Lt(_) -> { self(!int_add(n, 1)) } | (_) -> { n } }
    })
    count(0)`);
  const m = new Machine(ir);
  let slices = 0;
  let r;
  do {
    r = m.run(m.steps + 1000);
    slices++;
  } while (r.status === "budget");
  assert.equal(r.status, "done");
  assert.equal(r.value, 10000);
  assert.ok(slices > 10, `expected many slices, got ${slices}`);
});

test("tail recursion runs in constant space", () => {
  const ir = parse(`!fix((self, n) -> { self(!int_add(n, 1)) })(0)`);
  const index = indexPrograms([ir]);
  const m = new Machine(ir);
  m.run(10_000);
  const small = measure(m.state(), index, 1e6);
  m.run(200_000);
  assert.equal(measure(m.state(), index, 1e6), small);
});

test("integer overflow and oversized strings stop the program", () => {
  const big = evaluate(parse(`!int_multiply(9007199254740991, 2)`));
  assert.equal(big.status, "error");
  assert.ok("Unrepresentable" in big.reason);
  const long = evaluate(parse(`!fix((self, s) -> { self(!string_append(s, s)) })("ab")`), { limits: { maxStringLength: 1024 } });
  assert.equal(long.status, "error");
  assert.ok("LimitExceeded" in long.reason);
});

test("deep equality is charged per node compared", () => {
  const ir = parse(`
    let build = !fix((self, n) -> { match !int_compare(n, 0) { Eq(_) -> { [] } | (_) -> { [n, ..self(!int_subtract(n, 1))] } } })
    let a = build(500)
    let b = build(500)
    let mark = perform Mark({})
    !equal(a, b)`);
  const m = new Machine(ir);
  assert.equal(m.run().status, "effect");
  const before = m.steps;
  m.resume(0);
  assert.equal(m.run().value.l, "True");
  assert.ok(m.steps - before > 1000, `equal cost only ${m.steps - before} steps`);
});

test("a suspended continuation survives a JSON round trip", () => {
  const source = `
    let loop = !fix((self, acc) -> {
      let n = perform Next({})
      match !int_compare(n, 0) { Eq(_) -> { acc } | (_) -> { self([n, ..acc]) } }
    })
    loop([])`;
  const replies = [3, 2, 1, 0];
  const ir = parse(source);
  const m = new Machine(ir);
  m.run();
  m.resume(replies[0]);
  m.run();
  // Freeze mid-program, serialize, and continue in a fresh machine.
  const index = indexPrograms([ir]);
  const json = JSON.stringify(freeze(m.state(), index));
  const ir2 = parse(source);
  const restored = new Machine(null, { state: thaw(JSON.parse(json), indexPrograms([ir2])) });
  let r;
  for (const reply of replies.slice(1)) {
    restored.resume(reply);
    r = restored.run();
  }
  assert.equal(r.status, "done");
  assert.equal(show(r.value), "[1, 2, 3]");
});

test("snapshots of shared structure stay small", () => {
  const ir = parse(`!fix((self, n, l) -> { match !int_compare(n, 0) { Eq(_) -> { perform Stop(l) } | (_) -> { self(!int_subtract(n, 1), [l, l]) } } })(60, [])`);
  const m = new Machine(ir);
  assert.equal(m.run().status, "effect");
  const json = JSON.stringify(freeze(m.state(), indexPrograms([ir])));
  assert.ok(json.length < 100_000, `snapshot is ${json.length} bytes`);
});

test("validation lists effects and rejects what the game does not offer", () => {
  const opts = { allowedEffects: ["Look", "Move"] };
  assert.deepEqual(check(`let v = perform Look({})\nperform Move(North({}))`, opts).effects, ["Look", "Move"]);
  assert.match(check(`perform Teleport({})`, opts).errors[0], /Teleport is not available/);
  assert.match(check(`let x = import "./other.eyg"\nx`, opts).errors[0], /References are not available/);
  assert.match(check(`!eval("x")`, opts).errors[0], /Unknown builtin !eval/);
  // A program may handle any effect itself; only effects reaching the host count.
  assert.equal(check(`handle Teleport((x, k) -> { k({}) }, (_) -> { {} })`, opts).ok, true);
});
