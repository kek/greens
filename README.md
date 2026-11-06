# Greens

Greens is a programming game in which players never send moves. Each player submits a program written in [EYG](https://github.com/CrowdHailer/eyg-lang), and the server runs every program on every bot, every tick, under identical limits. Bots harvest green patches for energy, split to grow their colony and attack rival colonies. Whoever has the most bots at the end wins, with stored energy breaking ties.

The game is designed so that fairness is a property of the server rather than a promise from the clients. There is no game client to modify, a program can only do what its effects allow, and every match can be replayed and checked by anyone.

Requires Node 22 or later. There are no dependencies.

```sh
node bin/greens.js check bots/*.eyg
node bin/greens.js run bots/forager.eyg bots/raider.eyg --seed 3 --replay match.json
node bin/greens.js verify match.json
node bin/greens.js serve --port 8080 --data ./data   # then open http://127.0.0.1:8080
npm test
```

`run --watch` animates the match in the terminal. The viewer at `viewer/index.html` plays any replay file. When it is served by `greens serve`, it can also submit programs and start matches.

## Rules

The map is a 24 by 24 grid of floor, walls and patches. One quadrant is generated from the match seed and mirrored into the other three, so every corner is identical. Each player starts with one bot in a corner. A bot has 3 hit points and starts with 10 energy, and it can carry at most 20.

Every tick, each bot's program runs until it performs one action. All actions are then resolved together from the state of the world at the start of the tick:

1. **Attack** deals 1 damage to whatever bot stood on the target cell. All damage lands at once, so two bots can destroy each other.
2. **Harvest** takes 1 energy from an adjacent patch. If a patch cannot give a unit to every bot harvesting it, it gives none.
3. **Move** and **Split** claim an adjacent empty cell. A claim succeeds only when nobody else claims the same cell. Split costs 10 energy and creates a new bot with no energy that runs the same program from the start.

Patches hold up to 12 energy and regrow one unit every 5 ticks. A colony is capped at 30 bots, and the match ends after 400 ticks or when only one colony remains. Every number above is in `src/game/rules.js`, and each replay records the rules it was played under.

## Writing a bot

A program is an EYG expression; see the upstream [syntax guide](https://github.com/CrowdHailer/eyg-lang/blob/main/guides/syntax.md). It talks to the game only through these effects:

| Effect | Argument | Returns | Ends the turn |
| --- | --- | --- | --- |
| `Look` | `{}` | `{tick, width, height, me: {id, x, y, hp, energy}, cells}` | no |
| `Random` | positive integer `n` | integer in `0..n-1` | no |
| `Log` | any value | `{}` | no |
| `Move`, `Harvest`, `Attack`, `Split` | `North({})`, `East({})`, `South({})` or `West({})` | `Ok({})` or `Error(reason)` | yes |
| `Wait` | `{}` | `Ok({})` | yes |

`cells` lists the non-empty cells within 5 steps in each direction (Chebyshev distance) as `{x, y, what}`, where `what` is `Wall({})`, `Patch({amount})`, `Ally({id, hp, energy})` or `Enemy({hp})`. Coordinates and directions are in the player's own frame, so every player sees the map as if they started in the north-west corner. An action's result is what `perform` returns at the start of the next tick.

When a program finishes, the server starts it again for the next decision, within the same step budget. Programs that want memory between decisions can loop with `!fix`. If a program crashes, the error is logged and the program restarts the next tick. See `bots/forager.eyg` and `bots/raider.eyg`.

## Why it is fair

**No client to cheat with.** The server owns the world. Players upload source code, so there is no position, input or timing for a modified client to forge.

**Capabilities are checked before play.** EYG names effects statically (`perform Move`), so the server can list every effect a program could ever ask for. Programs that use an effect the game does not offer, import other code or name an unknown builtin are rejected at submission. A program can still define and handle its own effects internally; only effects that reach the host count.

**Equal compute, measured exactly.** Each bot gets 3,000 evaluation steps per tick on a deterministic interpreter. The count does not depend on hardware, server load or the order in which bots run. Operations that do more work in a single step, such as deep equality, finding an effect handler or splitting a string, are charged for that work. A program that runs out of budget is suspended mid-computation and continues next tick, so long computations are allowed but cost turns. Integers are limited to the safe-integer range, strings to 1,024 characters, and the state a bot keeps between ticks to about 20,000 heap objects.

**No hidden channels.** There is no clock or system randomness. `Random` draws from a per-bot generator seeded from the match seed and the bot's lineage. `Look` only reports what the bot can see, so fog of war is enforced exactly.

**Order never matters.** Actions are collected from every bot and resolved together under symmetric rules. Contested cells and contested patches fail for everyone involved.

**Symmetric by construction.** The map is mirrored, each player sees it in their own frame, bot ids are numbered per player and random seeds follow lineage rather than player number. The test suite checks the consequence: the same program playing itself produces an exact mirror-image game and a draw, with two players or four.

**Verifiable results.** A match is a pure function of the programs, the seed and the rules. Each replay stores those inputs along with every frame and a chained SHA-256 hash of the world state at each tick. `greens verify` re-runs the match and reports the first tick at which a frame differs, so a forged result or an edited replay is caught.

**Suspend and resume.** Every bot's continuation is plain data. `Match#save` serializes a match in progress, with every suspended program, to JSON. `Match.load` continues it, and the test suite checks that a resumed match ends with the same hash as one that ran without stopping.

## Design and code

| Path | Purpose |
| --- | --- |
| `src/eyg/interpreter.js` | Step-metered CEK interpreter that follows the reference interpreter in eyg-lang |
| `src/eyg/parser.js` | EYG text syntax to the JSON IR from the EYG spec |
| `src/eyg/validate.js` | Effect and builtin checks before a program is accepted |
| `src/eyg/snapshot.js` | Graph serialization of continuations and state-size measurement |
| `src/game/match.js` | World, tick resolution, replays, save/load and verification |
| `src/game/map.js` | Mirrored map generation and player frames |
| `src/server.js` | HTTP API; matches run in worker threads with a time limit |
| `viewer/index.html` | Replay viewer and match lobby |

The interpreter passes the upstream EYG evaluation suites in `test/spec`, copied unchanged from eyg-lang (see `test/spec/NOTICE`). The server's API is `POST /api/programs {name, source}`, `GET /api/programs`, `POST /api/matches {programs: [id, id], seed?}`, `GET /api/matches` and `GET /api/matches/:id`, which returns the replay.

## Limitations

The submission check is syntactic, not EYG's full type inference. It is exact for host effects, but a badly typed program is only found at run time, where it crashes its own bot. Running the upstream type checker at submission would catch this earlier.

Nothing in the language can stop collusion between players or one person entering several programs into a free-for-all. Those are matchmaking problems.

The trusted core is the interpreter, the rules engine and Node itself. Determinism has been tested on one Node version. `!string_length` and string splitting on `""` rely on Unicode grapheme segmentation, which could change between ICU versions; a long-lived league should pin the runtime.

The server keeps programs and replays in memory, optionally mirrored to a data directory. It has no accounts, so anyone who can reach it can submit programs and start matches. It listens on localhost by default.
