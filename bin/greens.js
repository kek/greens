#!/usr/bin/env node
// Greens command line: check programs, run matches, verify replays, serve.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { check } from "../src/eyg/validate.js";
import { Match, ProgramError, verify } from "../src/game/match.js";
import { EFFECTS } from "../src/game/rules.js";
import { startServer } from "../src/server.js";

const USAGE = `Usage:
  greens check <bot.eyg>...                     validate programs and list their effects
  greens run <a.eyg> <b.eyg> [c.eyg] [d.eyg]    play a match
        [--seed N] [--ticks N] [--replay out.json] [--watch]
  greens verify <replay.json>                   re-run a replay and compare every tick
  greens show <replay.json> [--tick N]          print the board at a tick
  greens serve [--port 8080] [--host 127.0.0.1] [--data dir]`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seed: { type: "string" },
    ticks: { type: "string" },
    replay: { type: "string" },
    watch: { type: "boolean" },
    tick: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    data: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...args] = positionals;
const glyph = ["A", "B", "C", "D"];

function board(replay, frame) {
  const rows = replay.map.map((r) => r.split(""));
  replay.patchCells.forEach((ci, i) => {
    const w = replay.rules.width;
    if (frame.patches[i] === 0) rows[(ci / w) | 0][ci % w] = "o";
  });
  for (const [, player, x, y] of frame.bots) rows[y][x] = glyph[player];
  return rows.map((r) => r.join("")).join("\n");
}

function score(result) {
  const lines = result.scores.map((s, i) => `  ${glyph[i]} ${s.name.padEnd(16)} bots ${String(s.bots).padStart(3)}  energy ${s.energy}`);
  const outcome = result.draw ? (result.winners.length ? `draw between ${result.winners.join(", ")}` : "draw") : `winner: ${result.winners[0]}`;
  return `${lines.join("\n")}\n  tick ${result.tick}, ${outcome}\n  hash ${result.hash}`;
}

function main() {
  if (!command || values.help) return console.log(USAGE);
  switch (command) {
    case "check": {
      let failed = false;
      for (const file of args) {
        const r = check(readFileSync(file, "utf8"), { allowedEffects: EFFECTS });
        if (r.ok) console.log(`${file}: ok, effects ${r.effects.join(", ") || "none"}`);
        else {
          failed = true;
          console.log(`${file}: rejected\n  ${r.errors.join("\n  ")}`);
        }
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case "run": {
      if (args.length < 2) return console.log(USAGE);
      const players = args.map((file) => ({ name: basename(file).replace(/\.eyg$/, ""), source: readFileSync(file, "utf8") }));
      const rules = values.ticks ? { maxTicks: Number(values.ticks) } : {};
      const match = new Match({ players, seed: Number(values.seed ?? 1), rules });
      match.run((m) => {
        if (!values.watch) return;
        const r = m.replay();
        process.stdout.write(`\x1b[H\x1b[2J${board(r, r.frames.at(-1))}\ntick ${m.tick}\n`);
      });
      const replay = match.replay();
      console.log(board(replay, replay.frames.at(-1)));
      console.log(score(replay.result));
      if (values.replay) {
        writeFileSync(values.replay, JSON.stringify(replay));
        console.log(`  replay written to ${values.replay}`);
      }
      return;
    }
    case "verify": {
      const replay = JSON.parse(readFileSync(args[0], "utf8"));
      const r = verify(replay);
      if (r.ok) console.log(`verified: ${replay.frames.length - 1} ticks reproduce exactly\n${score(r.result)}`);
      else {
        console.log(`replay does not match at tick ${r.tick}${r.reason ? ` (${r.reason})` : ""}`);
        process.exitCode = 1;
      }
      return;
    }
    case "show": {
      const replay = JSON.parse(readFileSync(args[0], "utf8"));
      const t = Math.min(Number(values.tick ?? replay.frames.length - 1), replay.frames.length - 1);
      const frame = replay.frames[t];
      console.log(board(replay, frame));
      console.log(`tick ${frame.tick}  hash ${frame.hash}`);
      for (const [player, id, message] of frame.logs) console.log(`  ${glyph[player]}#${id}: ${message}`);
      return;
    }
    case "serve": {
      const port = Number(values.port ?? 8080);
      const host = values.host ?? "127.0.0.1";
      startServer({ port, host, data: values.data });
      console.log(`Greens server on http://${host}:${port}`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

try {
  main();
} catch (e) {
  if (e instanceof ProgramError) {
    console.error(`${e.player} was rejected:\n  ${e.errors.join("\n  ")}`);
    process.exitCode = 1;
  } else throw e;
}
