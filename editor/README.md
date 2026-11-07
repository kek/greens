# Greens editor

The browser editor for Greens bots. It embeds `morph`, the structural editor
behind [eyg.run](https://eyg.run), in a small Lustre app that type checks
bots against the effects Greens offers. The page loads the compiled bundle
from `viewer/editor.js`, which is committed, so running Greens needs only
Node.

To rebuild the bundle after changing `src/`, install Gleam 1.19 and run
`./build.sh`. It checks out eyg-lang at a pinned commit into `vendor/`,
compiles to JavaScript and bundles with esbuild. Third-party code in the
bundle is listed in `NOTICE`.

`src/greens_editor.gleam` holds the effect types. Keep them in step with
`src/game/match.js` when the game's effects change.
