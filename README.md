# qrdecode

# Slop Alert

This repo is vibe-coded with Claude.

## Description

Human-assisted QR code decoding, entirely in the browser. Built for the case where
automated scanners give up: a damaged, dirty, partially-obscured, or badly-photographed
QR code that a person can help recover module by module.

Plain static HTML/CSS/JS — no build step, no dependencies, no network. Open
`index.html` directly, or serve the folder with any static server.

## Workflow

1. **Load an image** — open, drag-drop, or paste from the clipboard.
2. **Align the grid** — finder patterns are auto-detected when possible; a grid is
   projected over the symbol with a sample dot at each module center (black/white =
   what the sampler reads). Drag the four corner handles to fix alignment
   (perspective is handled), pick the version, and adjust the sampling threshold.
   Arrow keys nudge the selected handle; hold Shift for 0.1 px steps.

   Modules whose value is fixed by the spec — finder rings, separators, timing,
   alignment patterns, the dark module, plus format/version info under the currently
   assumed EC+mask — are **tinted red when they disagree** with expectation, and the
   sidebar counts the mismatches, so you can see alignment quality at a glance.

   For photos of QR codes on **curved surfaces**, enable **warp**: the grid gains
   edge-midpoint and center handles (nine total) and becomes a biquadratic surface
   that bends with the label — drag any handle and the grid point under it follows
   exactly. **Flatten** removes accumulated curvature while keeping the corners.
3. **Read the decode** — below the image: recovered text, segment structure, and
   every codeword grouped by error-correction block. Reed-Solomon runs per block, so
   an uncorrectable block doesn't stop the rest from decoding (partial decoding).
   Characters that depend on a failed block are flagged red as suspect.
4. **Fix bits by hand** — click any module to cycle auto → force-black → force-white
   → auto (right-click resets). Forced modules are marked with red squares. The
   decode updates live, and corrected codewords report what changed.
5. **Trace provenance** — hover a decoded character, codeword, segment, or block
   chip and the exact source modules light up on the image (strong = the exact bits,
   medium = the full codeword, faint = the whole EC block). Hover a module on the
   image to highlight its codeword and character in the output. This is how you find
   *which* modules to try flipping to make the output make sense.

The sidebar also shows what the format info actually reads (EC level, mask, and its
hamming distance) and, for version ≥ 7 symbols, what the version info bits say —
both can be overridden manually when those regions are damaged.

## Layout of the code

| file | contents |
| --- | --- |
| `js/gf256.js` | GF(256) arithmetic, Reed-Solomon decoder (Berlekamp-Massey + Chien + GF Gaussian solve, verified) |
| `js/qrspec.js` | spec tables: EC blocks per version/level, masks, format/version info BCH, alignment positions, interleaving |
| `js/matrix.js` | function-pattern map and zigzag data-module read order |
| `js/decode.js` | matrix → codewords → per-block RS → bitstream parse (numeric/alnum/byte/kanji/ECI), with bit→module provenance kept throughout |
| `js/homography.js` | grid ↔ image mapping: 4-corner projective, plus 3×3 biquadratic warp (Lagrange forward, Newton inverse) |
| `js/detect.js` | adaptive binarization + 1:1:3:1:1 finder-pattern scan + corner/version estimation |
| `js/app.js` | canvas UI, interactions, sidebar, output rendering and cross-highlighting |

The decode pipeline is tested against the `qrcode` npm encoder across all versions
(1–40), all EC levels, and all 8 masks, including corruption/recovery and
partial-decode scenarios.
