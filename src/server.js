// The Greens game server. Players submit EYG programs, as text or as IR
// from the structural editor; the server checks them,
// runs matches between submitted programs and publishes verifiable replays.
// Players never send moves, so there is no client to tamper with.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { check, validateShape } from "./eyg/validate.js";
import { parse } from "./eyg/parser.js";
import { print, PrintError } from "./eyg/print.js";
import { DEFAULT_RULES, EFFECTS } from "./game/rules.js";

const VIEWER = new URL("../viewer/index.html", import.meta.url);
const EDITOR = new URL("../viewer/editor.js", import.meta.url);
const MAX_BODY = 128 * 1024;
const MATCH_TIMEOUT_MS = 60_000;
const TYPECHECK_TIMEOUT_MS = 5_000;
const NAME = /^[A-Za-z0-9 _-]{1,32}$/;
const CHECK = { allowedEffects: EFFECTS, maxSourceBytes: DEFAULT_RULES.maxSourceBytes };

// Text for a program that came from the editor, or null if it has none.
// Replays decide separately whether the text reproduces the IR exactly.
function printable(ir) {
  try {
    return print(ir);
  } catch (e) {
    if (e instanceof PrintError) return null;
    throw e;
  }
}

export function startServer({ port = 8080, host = "127.0.0.1", data } = {}) {
  const programs = new Map();
  const matches = new Map();
  let running = 0;

  if (data) {
    mkdirSync(join(data, "programs"), { recursive: true });
    mkdirSync(join(data, "matches"), { recursive: true });
    for (const f of readdirSync(join(data, "programs"))) {
      const p = JSON.parse(readFileSync(join(data, "programs", f), "utf8"));
      if (!p.ir && typeof p.source === "string") p.ir = parse(p.source);
      programs.set(p.id, p);
    }
    for (const f of readdirSync(join(data, "matches"))) {
      const m = JSON.parse(readFileSync(join(data, "matches", f), "utf8"));
      matches.set(m.id, m);
    }
  }
  const persist = (kind, item) => data && writeFileSync(join(data, kind, `${item.id}.json`), JSON.stringify(item));

  const summary = (m) => ({ id: m.id, created: m.created, players: m.replay.players.map((p) => p.name), seed: m.replay.seed, result: m.replay.result });

  async function route(req, url) {
    const path = url.pathname;
    if (req.method === "GET" && (path === "/" || path === "/index.html")) return { type: "text/html", body: readFileSync(VIEWER) };
    if (req.method === "GET" && path === "/editor.js") return { type: "text/javascript", body: readFileSync(EDITOR) };
    if (req.method === "GET" && path === "/api/rules") return json({ rules: DEFAULT_RULES, effects: EFFECTS });
    if (req.method === "GET" && path === "/api/programs") {
      return json([...programs.values()].map(({ id, name, effects, typeErrors, created }) => ({ id, name, effects, typeErrors, created })));
    }
    if (req.method === "GET" && path.startsWith("/api/programs/")) {
      const p = programs.get(path.slice("/api/programs/".length));
      return p ? json({ ...p, source: p.source ?? printable(p.ir) }) : json({ error: "No such program" }, 404);
    }
    if (req.method === "POST" && path === "/api/programs") {
      const body = await readJson(req);
      if (typeof body.name !== "string" || !NAME.test(body.name)) return json({ error: "name must be 1-32 letters, digits, spaces, _ or -" }, 400);
      if (typeof body.source !== "string" && (typeof body.ir !== "object" || body.ir === null)) return json({ error: "Send the program as source text or as ir" }, 400);
      const result = check(typeof body.source === "string" ? body.source : { ir: body.ir }, CHECK);
      if (!result.ok) return json({ error: "Program rejected", errors: result.errors }, 400);
      // Only text the player wrote is kept as source; IR from the editor is
      // printed on request.
      const source = typeof body.source === "string" ? body.source : null;
      // Type errors are reported, not rejected: the game runs any program
      // that passes the checks above, and a mistyped bot only hurts itself.
      const typeErrors = await typecheck(result.ir);
      const program = { id: randomUUID(), name: body.name, source, ir: result.ir, effects: result.effects, typeErrors, created: new Date().toISOString() };
      programs.set(program.id, program);
      persist("programs", program);
      return json({ id: program.id, effects: program.effects, typeErrors }, 201);
    }
    // Text to IR and back, for the editor page.
    if (req.method === "POST" && path === "/api/parse") {
      const body = await readJson(req);
      if (typeof body.source !== "string") return json({ error: "source must be a string" }, 400);
      try {
        return json({ ir: parse(body.source) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    if (req.method === "POST" && path === "/api/print") {
      const body = await readJson(req);
      const shape = validateShape(body.ir);
      if (shape.length) return json({ error: "Not a program", errors: shape }, 400);
      try {
        return json({ source: print(body.ir) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    if (req.method === "GET" && path === "/api/matches") return json([...matches.values()].map(summary));
    if (req.method === "GET" && path.startsWith("/api/matches/")) {
      const m = matches.get(path.slice("/api/matches/".length));
      return m ? json(m.replay) : json({ error: "No such match" }, 404);
    }
    if (req.method === "POST" && path === "/api/matches") {
      const body = await readJson(req);
      const ids = Array.isArray(body.programs) ? body.programs : [];
      if (ids.length < 2 || ids.length > 4) return json({ error: "programs must list 2 to 4 program ids" }, 400);
      const players = ids.map((id) => programs.get(id));
      if (players.some((p) => !p)) return json({ error: "Unknown program id" }, 400);
      const seed = Number.isSafeInteger(body.seed) ? body.seed : Math.floor(Math.random() * 2 ** 31);
      if (running >= 2) return json({ error: "The server is busy, try again shortly" }, 503);
      running++;
      try {
        const replay = await runInWorker({ players: players.map(({ name, source, ir }) => (source ? { name, source } : { name, ir })), seed });
        const match = { id: randomUUID(), created: new Date().toISOString(), replay };
        matches.set(match.id, match);
        persist("matches", match);
        return json(summary(match), 201);
      } finally {
        running--;
      }
    }
    return json({ error: "Not found" }, 404);
  }

  const server = createServer(async (req, res) => {
    let out;
    try {
      out = await route(req, new URL(req.url, "http://localhost"));
    } catch (e) {
      out = json({ error: e.message }, e.status ?? 500);
    }
    res.writeHead(out.status ?? 200, { "content-type": out.type, "cache-control": "no-store" });
    res.end(out.body);
  });
  server.listen(port, host);
  return server;
}

function json(value, status = 200) {
  return { status, type: "application/json", body: JSON.stringify(value) };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Body must be JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function typecheck(ir) {
  try {
    const r = await runInWorker(ir, { script: "./eyg/typecheck-worker.js", timeout: TYPECHECK_TIMEOUT_MS, what: "Type check" });
    return r;
  } catch (e) {
    return [`type check did not finish: ${e.message}`];
  }
}

function runInWorker(workerData, { script = "./game/worker.js", timeout = MATCH_TIMEOUT_MS, what = "Match" } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(script, import.meta.url), { workerData, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${what} timed out`));
    }, timeout);
    worker.once("message", (m) => {
      clearTimeout(timer);
      worker.terminate();
      if (m.ok) resolve(m.replay ?? m.errors);
      else reject(Object.assign(new Error(m.error), { status: 400 }));
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

