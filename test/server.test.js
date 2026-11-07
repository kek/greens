import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startServer } from "../src/server.js";

test("the server accepts programs as text or IR and serves the editor", async (t) => {
  const server = startServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const forager = readFileSync(new URL("../bots/forager.eyg", import.meta.url), "utf8");
  const text = await (await post("/api/programs", { name: "forager", source: forager })).json();
  const { ir } = await (await post("/api/parse", { source: "let v = perform Look({})\nperform Move(East({}))" })).json();
  const fromEditor = await (await post("/api/programs", { name: "east", ir })).json();
  assert.deepEqual(fromEditor.effects, ["Look", "Move"]);
  assert.deepEqual(fromEditor.typeErrors, []);
  const mistyped = await (await post("/api/programs", { name: "up", source: "perform Move(Up({}))" })).json();
  assert.equal(mistyped.typeErrors.length, 1);

  const stored = await (await fetch(`${base}/api/programs/${fromEditor.id}`)).json();
  assert.equal(stored.source, "let v = perform Look({})\nperform Move(East({}))\n");
  assert.deepEqual((await (await post("/api/print", { ir })).json()).source, stored.source);

  const rejected = await post("/api/programs", { name: "cheat", ir: { 0: "a", f: { 0: "p", l: "Teleport" }, a: { 0: "u" } } });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).errors[0], /Teleport is not available/);

  const match = await (await post("/api/matches", { programs: [fromEditor.id, text.id], seed: 2 })).json();
  assert.equal(match.result.over, true);

  const editor = await fetch(`${base}/editor.js`);
  assert.equal(editor.status, 200);
  assert.match(await editor.text(), /GreensEditor/);
});
