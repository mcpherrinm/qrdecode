# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Human-assisted QR code decoding, entirely in the browser — for codes automated scanners give up on (damaged, dirty, obscured, badly photographed). The human aligns a warpable grid over the photo and forces/ignores individual modules; the decoder does the rest. Partial decoding and bit→module provenance are core features, not afterthoughts: Reed-Solomon runs per EC block so one dead block doesn't kill the rest, and every output character traces back to its source modules via hover cross-highlighting.

## Running and testing

- Plain static HTML/CSS/JS. **No build step, no dependencies, no package.json.** Open `index.html` directly (file:// works) or serve the folder with any static server.
- Scripts are **classic scripts, not ES modules** (so file:// works). Each `js/*.js` file exposes globals; `index.html` loads them in dependency order (gf256 → qrspec → matrix → homography → detect → decode → app). Keep it that way — no `import`/`export`.
- **Node/npm are not installed on this machine.** Use `/Users/m/.bun/bin/bun` for any scripting or tests.
- There is no test harness in the repo. Past sessions validated the decode pipeline in a scratchpad harness run under bun: matrix-level round-trips against the `qrcode` npm encoder (versions 1–40, all EC levels, all 8 masks, corruption/recovery and partial-decode cases), PNG raster tests against `samples/`, and a happy-dom UI smoke test. Recreate that harness in the session scratchpad when needed — don't add it, node_modules, or a package.json to the repo.
- `samples/` holds test images (clean, rotated, curved, damaged, photo).

## Architecture

Everything below `app.js` is pure logic with no DOM dependency (that's what makes it testable under bun):

- `js/gf256.js` — GF(256) arithmetic and the Reed-Solomon decoder, **with erasure support**: `rsDecode` corrects e errors + f erasures when 2e + f ≤ nsym. Erasures come from user-ignored modules.
- `js/qrspec.js` — spec tables: EC block structure per version/level, mask predicates, format/version info BCH, alignment positions, codeword interleaving.
- `js/matrix.js` — `getLayout(version)`: function-pattern map (which modules are finder/timing/alignment/format/etc.) and the zigzag read order mapping data-module index ↔ (row, col).
- `js/homography.js` — grid ↔ image coordinate mapping: 4-corner projective (`makeFlatMap`) and a 3×3-control-point biquadratic warp for curved surfaces (`makeWarpMap`, Lagrange forward / Newton inverse).
- `js/detect.js` — `detectQR(imageData)`: adaptive binarization (tried at two threshold factors × both polarities — inverted symbols set `inverted` in the result and the app's invert toggle) + 1:1:3:1:1 finder scan with h/v/diagonal cross-checks. Candidate triples are validated by tilt-invariant module spans and timing-pattern alternation; if no triple survives, two finders + timing rescue the grid (third center synthesized, then template-matched). Version comes from the version-info bits (BCH-checked) on v≥7, else from finder spacing. When the affine grid fits the known patterns poorly, the bottom-right alignment pattern anchors a full projective fit.
- `js/decode.js` — `decodeMatrix(getBit, version, opts)`: matrix → de-interleave → per-block RS → bitstream parse (numeric/alnum/byte/kanji/ECI). Threads bit→module provenance through the whole pipeline so the UI can highlight source modules for any output char/codeword/block, and returns partial results when blocks fail (affected characters flagged suspect).
- `js/app.js` (the bulk of the code) — canvas UI: rendering, the nine-handle warp grid plus rotate/scale/move handles, module override interactions (auto/force/ignore states in `state.overrides`), undo/redo, sidebar, output rendering, and cross-highlighting. Central mutable `state` object at the top of the file. Session (image, grid, overrides, settings, view) persists to IndexedDB and is restored on reload; loading a new image replaces it.

The sampler reads each module center through the mapper; user overrides sit on top of sampled bits (`0`/`1` forced, `2` = ignored → RS erasure). Any change reruns `decodeMatrix` live.

## Conventions

- Design language: black/white monospace grid aesthetic with a single red accent for errors/highlights. Keep new UI within that.
- The README's Workflow section documents user-facing behavior in detail — update it when behavior changes.
