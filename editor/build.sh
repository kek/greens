#!/usr/bin/env bash
# Rebuild viewer/editor.js and src/eyg/typecheck.js from the Gleam sources
# in this directory.
# Needs gleam 1.19 and Node. The Greens server itself never runs this.
set -euo pipefail
cd "$(dirname "$0")"
EYG_COMMIT=99c2ef5e1740df350663ee009eb3665797315090
if [[ ! -d vendor/eyg-lang ]]; then
  git clone --quiet https://github.com/CrowdHailer/eyg-lang vendor/eyg-lang
fi
git -C vendor/eyg-lang fetch --quiet origin "$EYG_COMMIT" 2>/dev/null || true
git -C vendor/eyg-lang checkout --quiet "$EYG_COMMIT"
gleam build
npx --yes esbuild@0.25.10 entry.mjs --bundle --minify --format=iife \
  --legal-comments=eof --outfile=../viewer/editor.js \
  --banner:js='/* Greens editor. Built from editor/ by build.sh; bundled third-party code is listed in editor/NOTICE. */'
npx --yes esbuild@0.25.10 typecheck-entry.mjs --bundle --minify --format=esm --platform=neutral \
  --legal-comments=eof --outfile=../src/eyg/typecheck.js \
  --banner:js='/* Greens type checker. Built from editor/ by build.sh; bundled third-party code is listed in editor/NOTICE. */'
