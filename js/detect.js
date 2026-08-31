// Finder-pattern detection: locate the three 1:1:3:1:1 squares and estimate
// the symbol's corners and version. Best-effort — the human refines the rest.
'use strict';

// imageData at (possibly reduced) scale. Returns null or
// {corners: [TL,TR,BR,BL] image coords, version, moduleSize, inverted}.
function detectQR(imageData) {
  const w = imageData.width, h = imageData.height;
  const gray = toGray(imageData);
  // Try progressively more forgiving readings of the image: normal polarity
  // first, then colour-inverted (light-on-dark symbols), then both again with
  // a fatter threshold — washed-out photos (screen glare, glow) erode the
  // finder rings so far below nominal width that the ratio test can't fire.
  let bin = null, best = null, inverted = false;
  const tried = [];
  const accept = (t, found) => { bin = t.bin; best = found; inverted = t.inverted; };
  // Tier 1: three finders whose geometry is confirmed by both timing patterns.
  outer:
  for (const factor of [0.85, 1.0]) {
    let bv = binarize(gray, w, h, factor);
    for (const inv of [false, true]) {
      if (inv) {
        const f = new Uint8Array(bv.length);
        for (let i = 0; i < bv.length; i++) f[i] = 1 - bv[i];
        bv = f;
      }
      const cands = findFinderCandidates(bv, w, h);
      cands.sort((a, b) => b.count - a.count);
      const t = { bin: bv, inverted: inv, cands };
      tried.push(t);
      const found = scanTriple(bv, w, h, cands, true);
      if (found) { accept(t, found); break outer; }
    }
  }
  // Tier 2: one finder may be ruined (glare, damage) — two good ones still
  // pin the grid: the timing patterns say which pair and which side, and the
  // third center is synthesized perpendicular.
  if (!best) {
    for (const t of tried) {
      const found = pairFallback(t.bin, w, h, t.cands);
      if (found) { accept(t, found); break; }
    }
  }
  // Tier 3: any span-consistent triple, timing unread — on badly degraded
  // symbols a rough grid to hand-tune still beats nothing.
  if (!best) {
    for (const t of tried) {
      const found = scanTriple(t.bin, w, h, t.cands, false);
      if (found) { accept(t, found); break; }
    }
  }
  if (!best) return null;
  let { tl, tr, bl } = best;

  const msize = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3;
  let dim = Math.round((best.spanTop + best.spanLeft) / 2) + 7;
  dim = Math.max(21, Math.min(177, dim));
  // Snap to nearest valid dimension (== 21 mod 4, within [21, 177]).
  const rem = (dim - 21) % 4;
  if (rem !== 0) dim += rem <= 2 ? -rem : 4 - rem;
  dim = Math.max(21, Math.min(177, dim));
  // The run-length module-size estimate gets noisy on photos, where being one
  // version off scrambles the whole sampling grid. Version-info bits (v >= 7)
  // sit at fixed offsets from the TR/BL finder centers, so when they BCH-decode
  // cleanly they override the estimate.
  const refined = refineVersion(bin, w, h, tl, tr, bl);
  if (refined && (dim >= 41 || refined.distance <= 1)) dim = 17 + 4 * refined.version;
  const version = (dim - 17) / 4;

  // Per-module basis vectors from the finder centers.
  const span = dim - 7;
  const buildCorners = (ttl, ttr, tbl) => {
    const ex = { x: (ttr.x - ttl.x) / span, y: (ttr.y - ttl.y) / span };
    const ey = { x: (tbl.x - ttl.x) / span, y: (tbl.y - ttl.y) / span };
    const at = (p, mx, my) => ({ x: p.x + ex.x * mx + ey.x * my, y: p.y + ex.y * mx + ey.y * my });
    const cTL = at(ttl, -3.5, -3.5);
    const cTR = at(ttr, 3.5, -3.5);
    const cBL = at(tbl, -3.5, 3.5);
    return [cTL, cTR, { x: cTR.x + cBL.x - cTL.x, y: cTR.y + cBL.y - cTL.y }, cBL];
  };
  let corners = buildCorners(tl, tr, bl);
  // A pair-fallback grid assumed the symbol is square in image space, but
  // perspective foreshortens the synthesized leg. Search that leg's scale for
  // the best fit against the known function patterns.
  if (best.synth) {
    let bestM = knownMismatch(bin, w, h, corners, version);
    for (let s = 0.86; s <= 1.14; s += 0.005) {
      const p = best.synth === 'bl' ? bl : tr;
      const scaled = { x: tl.x + (p.x - tl.x) * s, y: tl.y + (p.y - tl.y) * s };
      const c2 = best.synth === 'bl' ? buildCorners(tl, tr, scaled) : buildCorners(tl, scaled, bl);
      const m2 = knownMismatch(bin, w, h, c2, version);
      if (m2 < bestM) {
        bestM = m2;
        corners = c2;
        if (best.synth === 'bl') bl = scaled; else tr = scaled;
      }
    }
  }
  // Three finder centers only give an affine grid: under real perspective the
  // extrapolated BR corner is off. When the grid fits the known patterns
  // poorly, hunt for the bottom-right alignment pattern and solve the full
  // projective grid through all four anchors.
  if (version >= 2 && knownMismatch(bin, w, h, corners, version) > 0.08) {
    const ap = locateAlignment(bin, w, h, corners, dim);
    if (ap) {
      const A = squareToQuad([{ x: 3.5, y: 3.5 }, { x: dim - 3.5, y: 3.5 },
                              { x: dim - 6.5, y: dim - 6.5 }, { x: 3.5, y: dim - 3.5 }], dim);
      const B = squareToQuad([tl, tr, ap, bl], dim);
      const G = matMul3(B, invertH(A));
      const c2 = [applyH(G, 0, 0), applyH(G, dim, 0), applyH(G, dim, dim), applyH(G, 0, dim)];
      if (knownMismatch(bin, w, h, c2, version) < knownMismatch(bin, w, h, corners, version)) {
        corners = c2;
      }
    }
  }
  return { corners, version, moduleSize: msize, inverted };
}

function matMul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}

// Find the bottom-right alignment pattern (5x5: dark dot, light ring, dark
// ring) near where the current grid expects it. Returns its center or null.
function locateAlignment(bin, w, h, corners, dim) {
  const map = makeFlatMap(corners, dim).map;
  const pred = map(dim - 6.5, dim - 6.5);
  const px = map(dim - 5.5, dim - 6.5), py = map(dim - 6.5, dim - 5.5);
  const exm = { x: px.x - pred.x, y: px.y - pred.y }; // one module along x
  const eym = { x: py.x - pred.x, y: py.y - pred.y };
  // Perspective error at the far corner easily reaches several modules even
  // on small symbols, so search generously.
  const R = Math.max(6, Math.min(20, Math.round(dim * 0.15)));
  const score = (cc) => {
    let ok = 0;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const e = Math.max(Math.abs(r), Math.abs(c));
        const want = e === 1 ? 0 : 1;
        const x = Math.round(cc.x + exm.x * c + eym.x * r);
        const y = Math.round(cc.y + eym.y * r + exm.y * c);
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        if (bin[y * w + x] === want) ok++;
      }
    }
    return ok / 25;
  };
  let best = { s: 0, cc: null };
  for (let a = -2 * R; a <= 2 * R; a++) {
    for (let b = -2 * R; b <= 2 * R; b++) {
      const cc = { x: pred.x + (exm.x * a + eym.x * b) / 2, y: pred.y + (exm.y * a + eym.y * b) / 2 };
      const s = score(cc);
      if (s > best.s) best = { s, cc };
    }
  }
  return best.s >= 0.8 ? best.cc : null;
}

// Fraction of the version's spec-fixed modules (finders, timing, alignment,
// dark module) that disagree with a flat grid over the given corners. The
// polish objective: cheap single-sample reads off the already-binarized image.
function knownMismatch(bin, w, h, corners, version) {
  const size = 17 + 4 * version;
  const expected = getLayout(version).expected;
  const map = makeFlatMap(corners, size).map;
  let mism = 0, known = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const e = expected[r * size + c];
      if (e < 0) continue;
      known++;
      const p = map(c + 0.5, r + 0.5);
      const x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= w || y >= h || bin[y * w + x] !== e) mism++;
    }
  }
  return known ? mism / known : 1;
}

// Two-finder rescue: for pairs of strong candidates, hypothesize which is the
// right-angle (TL) vertex and which side the symbol lies on, and validate by
// the alternation of BOTH timing patterns — only the true geometry has timing
// along its two legs (a wrong side lands in background, a wrong vertex runs a
// leg through data, a diagonal pair has neither). Returns the winning triple
// with the third finder center synthesized, or null.
function pairFallback(bin, w, h, cands) {
  const top = cands.slice(0, 6);
  // Strongest pairs first — the first one whose timing validates wins.
  const pairs = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) pairs.push([top[i], top[j]]);
  }
  pairs.sort((p, q) => q[0].count + q[1].count - p[0].count - p[1].count);
  for (const [a, b] of pairs) {
    if (Math.max(a.moduleSize, b.moduleSize) > Math.min(a.moduleSize, b.moduleSize) * 1.6) continue;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / dist, uy = (b.y - a.y) / dist;
    const msGuess = (a.moduleSize + b.moduleSize) / 2;
    const exts = [finderExtent(bin, w, h, a, ux, uy, msGuess),
                  finderExtent(bin, w, h, b, ux, uy, msGuess)].filter(e => e > 0);
    if (!exts.length) continue;
    const m = exts.reduce((s, e) => s + e, 0) / exts.length / 7;
    const span = dist / m;
    // Valid spans are 14..170; leave slack for extent-measurement error.
    if (span < 12 || span > 178) continue;
    let best = null;
    for (const s of [1, -1]) {
      const perp = { x: -uy * s * m, y: ux * s * m }; // one module, into the symbol
      for (const [v, partner] of [[a, b], [b, a]]) {
        const third = { x: v.x + perp.x * span, y: v.y + perp.y * span, moduleSize: m, count: 0 };
        // Assign roles so cross(TR-TL, BL-TL) > 0 (y down).
        const cr = (partner.x - v.x) * (third.y - v.y) - (partner.y - v.y) * (third.x - v.x);
        const tl = v, tr = cr > 0 ? partner : third, bl = cr > 0 ? third : partner;
        const exm = { x: (tr.x - tl.x) / span, y: (tr.y - tl.y) / span };
        const eym = { x: (bl.x - tl.x) / span, y: (bl.y - tl.y) / span };
        const t1 = timingScore(bin, w, h, tl, exm, eym, span);
        const t2 = timingScore(bin, w, h, tl, eym, exm, span);
        // The leg joining the two real candidates must carry solid timing; the
        // synthesized leg may run through exactly the damage that ruined the
        // third finder, so a clean version-info read vouches for it instead.
        const tPair = cr > 0 ? t1 : t2, tOther = cr > 0 ? t2 : t1;
        if (tPair < 0.75) continue;
        const ref = tOther < 0.7 ? refineVersion(bin, w, h, tl, tr, bl) : null;
        if (tOther < 0.7 && !(ref && ref.distance <= 1)) continue;
        const score = t1 + t2 + (ref && ref.distance <= 1 ? 1 : 0);
        if (!best || score > best.score) {
          best = { score, tl, tr, bl, spanTop: span, spanLeft: span, synth: cr > 0 ? 'bl' : 'tr' };
        }
      }
    }
    if (best) {
      // The synthesized corner assumed a square, fronto-parallel symbol;
      // perspective can put the real (often damaged) finder many modules
      // away. If a finder-shaped patch exists near the prediction, snap to it.
      const synthPt = best.synth === 'bl' ? best.bl : best.tr;
      const exm = { x: (best.tr.x - best.tl.x) / span, y: (best.tr.y - best.tl.y) / span };
      const eym = { x: (best.bl.x - best.tl.x) / span, y: (best.bl.y - best.tl.y) / span };
      const found = locateFinder(bin, w, h, synthPt, exm, eym, span);
      if (found) {
        const np = { x: found.x, y: found.y, moduleSize: m, count: 0 };
        if (best.synth === 'bl') best.bl = np; else best.tr = np;
        best.synth = null; // a real center now — no scale search needed
      }
      return best;
    }
  }
  return null;
}

// Exhaustive 9x9-module finder-template match around a predicted center
// (half-module steps). Returns the best-scoring center, or null when nothing
// there resembles a finder.
function locateFinder(bin, w, h, pred, exm, eym, span) {
  const R = Math.max(3, Math.min(24, Math.round(span * 0.14)));
  const score = (cc) => {
    let ok = 0;
    for (let r = -4; r <= 4; r++) {
      for (let c = -4; c <= 4; c++) {
        const e = Math.max(Math.abs(r), Math.abs(c));
        const want = e <= 1 ? 1 : e === 2 ? 0 : e === 3 ? 1 : 0;
        const x = Math.round(cc.x + exm.x * c + eym.x * r);
        const y = Math.round(cc.y + exm.y * c + eym.y * r);
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        if (bin[y * w + x] === want) ok++;
      }
    }
    return ok / 81;
  };
  let best = { s: 0, cc: null };
  for (let a = -2 * R; a <= 2 * R; a++) {
    for (let b = -2 * R; b <= 2 * R; b++) {
      const cc = { x: pred.x + (exm.x * a + eym.x * b) / 2, y: pred.y + (exm.y * a + eym.y * b) / 2 };
      const s = score(cc);
      if (s > best.s) best = { s, cc };
    }
  }
  return best.s >= 0.62 ? best.cc : null;
}

// Alternation rate along the timing pattern on one leg of the symbol: module
// row (or column) 6, between the separators. Exactly one sample per module
// center, flips counted between neighbors: 1.0 = perfect alternation, ~0.5 =
// random data (or noise — sub-module sampling would inflate noise past 1.0),
// ~0 = uniform background.
function timingScore(bin, w, h, tl, exm, eym, span) {
  // Timing module centers sit 3 modules off the finder-center line (finder
  // center row coord 3.5, timing row coord 6.5), at col coords 8.5..size-8.5.
  let prev = -1, trans = 0, n = 0;
  for (let t = 5; t <= span - 5; t += 1) {
    const x = Math.round(tl.x + exm.x * t + eym.x * 3);
    const y = Math.round(tl.y + exm.y * t + eym.y * 3);
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    const v = bin[y * w + x];
    if (prev >= 0 && v !== prev) trans++;
    prev = v;
    n++;
  }
  return n > 1 ? trans / (n - 1) : 0;
}

// Modules between two finder centers: their distance over the module pitch
// measured from the finders' own 7-module extents along that same line.
function dirSpan(bin, w, h, a, b, msFallback) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / dist, uy = (b.y - a.y) / dist;
  const exts = [finderExtent(bin, w, h, a, ux, uy, msFallback),
                finderExtent(bin, w, h, b, ux, uy, msFallback)].filter(e => e > 0);
  const m = exts.length ? exts.reduce((s, e) => s + e, 0) / exts.length / 7 : msFallback;
  return dist / m;
}

// Width of the finder pattern at p along the unit direction (ux,uy): walk out
// both ways through dark core, light ring, dark ring. -1 when the walk doesn't
// look like a finder (edge of image, damage) or lands far from 7 modules.
function finderExtent(bin, w, h, p, ux, uy, msGuess) {
  const half = (sgn) => {
    let phase = 0, lastDark = 0;
    for (let t = 0; t <= msGuess * 7; t += 0.25) {
      const x = Math.round(p.x + ux * sgn * t), y = Math.round(p.y + uy * sgn * t);
      const v = (x < 0 || y < 0 || x >= w || y >= h) ? 0 : bin[y * w + x];
      if (phase === 0) { if (v) lastDark = t; else phase = 1; }
      else if (phase === 1) { if (v) { phase = 2; lastDark = t; } }
      else if (v) lastDark = t;
      else break;
    }
    return phase === 2 ? lastDark : -1;
  };
  const out = half(1), back = half(-1);
  if (out < 0 || back < 0) return -1;
  const ext = out + back;
  return ext > msGuess * 4 && ext < msGuess * 10 ? ext : -1;
}

function scanTriple(bin, w, h, cands, requireTiming) {
  if (cands.length < 3) return null;
  // Try candidate triples best-first, validating each: a real symbol counts
  // the same number of modules along both legs (horizontal-scan run lengths
  // inflate by 1/cos(tilt), so spans are measured tilt-invariantly from the
  // finders' own extents along each leg). A triple mixing in a false finder
  // — an alignment pattern, dense data mimicking the ratio — doesn't. With
  // requireTiming, both timing patterns must alternate as well, which rejects
  // geometrically-plausible triples of lookalikes inside dense data.
  for (const t of pickTriples(cands.slice(0, 8))) {
    const ms = (t.tl.moduleSize + t.tr.moduleSize + t.bl.moduleSize) / 3;
    const spanTop = dirSpan(bin, w, h, t.tl, t.tr, ms);
    const spanLeft = dirSpan(bin, w, h, t.tl, t.bl, ms);
    if (Math.abs(spanTop - spanLeft) > Math.max(spanTop, spanLeft) * 0.14 + 2) continue;
    if (requireTiming) {
      const exm = { x: (t.tr.x - t.tl.x) / spanTop, y: (t.tr.y - t.tl.y) / spanTop };
      const eym = { x: (t.bl.x - t.tl.x) / spanLeft, y: (t.bl.y - t.tl.y) / spanLeft };
      const t1 = timingScore(bin, w, h, t.tl, exm, eym, spanTop);
      const t2 = timingScore(bin, w, h, t.tl, eym, exm, spanLeft);
      if (Math.min(t1, t2) < 0.6) continue;
    }
    return { ...t, spanTop, spanLeft };
  }
  return null;
}

// Read the 18-bit version info blocks for each candidate version's own module
// pitch (their offsets from the TR/BL finder centers don't depend on version)
// and keep the best BCH match. Returns {version, distance} or null.
function refineVersion(bin, w, h, tl, tr, bl) {
  const sample = (p) => {
    const x = Math.round(p.x), y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return bin[y * w + x];
  };
  let best = null;
  for (let v = 7; v <= 40; v++) {
    const span = 17 + 4 * v - 7;
    const ex = { x: (tr.x - tl.x) / span, y: (tr.y - tl.y) / span };
    const ey = { x: (bl.x - tl.x) / span, y: (bl.y - tl.y) / span };
    // Bit i of the TR copy sits at (row i/3|0, col size-11+i%3); its center,
    // relative to the TR finder center, is (dx, dy) = (i%3-7, (i/3|0)-3)
    // modules. The BL copy is its transpose relative to the BL center.
    let vTR = 0, vBL = 0;
    for (let i = 0; i < 18; i++) {
      const a = i % 3 - 7, b = (i / 3 | 0) - 3;
      if (sample({ x: tr.x + ex.x * a + ey.x * b, y: tr.y + ex.y * a + ey.y * b })) vTR |= 1 << i;
      if (sample({ x: bl.x + ex.x * b + ey.x * a, y: bl.y + ex.y * b + ey.y * a })) vBL |= 1 << i;
    }
    const pat = encodeVersionBits(v);
    const d = Math.min(popcount(pat ^ vTR), popcount(pat ^ vBL));
    if (!best || d < best.distance) best = { version: v, distance: d };
  }
  // BCH(18,6) corrects 3 errors; beyond that it's noise, not a version block.
  return best && best.distance <= 3 ? best : null;
}

function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = (data[j] * 77 + data[j + 1] * 151 + data[j + 2] * 28) >> 8;
  }
  return gray;
}

// Adaptive threshold blended with a global Otsu threshold. 1 = dark.
// factor scales the local mean: below 1 biases toward light (crisp input),
// 1.0 keeps everything under the local mean dark (washed-out photos).
function binarize(gray, w, h, factor = 0.85) {
  const globalT = otsu(gray);
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const win = Math.max(8, (Math.min(w, h) / 16) | 0);
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - win), y1 = Math.min(h, y + win + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - win), x1 = Math.min(w, x + win + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1]
                - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / area;
      const t = mean * factor + globalT * (1 - factor);
      bin[y * w + x] = gray[y * w + x] < t ? 1 : 0;
    }
  }
  return bin;
}

function otsu(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.min(255, Math.max(0, values[i] | 0))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, bestLo = 127, bestHi = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    // Ties are common on clean bilevel input (whole plateau of equal separations);
    // take the plateau midpoint so the threshold sits between the two populations.
    if (between > best) { best = between; bestLo = bestHi = t; }
    else if (between === best) bestHi = t;
  }
  return (bestLo + bestHi) / 2;
}

function ratioOK(runs, offset) {
  const total = runs[offset] + runs[offset + 1] + runs[offset + 2] + runs[offset + 3] + runs[offset + 4];
  if (total < 7) return 0;
  const t = total / 7;
  const v = t * 0.6;
  if (Math.abs(runs[offset] - t) < v && Math.abs(runs[offset + 1] - t) < v &&
      Math.abs(runs[offset + 2] - 3 * t) < 3 * v * 0.7 &&
      Math.abs(runs[offset + 3] - t) < v && Math.abs(runs[offset + 4] - t) < v) {
    return t;
  }
  return 0;
}

function findFinderCandidates(bin, w, h) {
  const cands = [];
  const step = Math.max(1, (h / 800) | 0);
  for (let y = 0; y < h; y += step) {
    // Run-length encode the row.
    const runs = [], starts = [];
    let x = 0;
    while (x < w) {
      const v = bin[y * w + x];
      const s = x;
      while (x < w && bin[y * w + x] === v) x++;
      runs.push(x - s);
      starts.push(s);
      if (runs.length === 1 && v === 1) { runs.unshift(0); starts.unshift(0); } // ensure starts light
    }
    // Windows of 5 runs starting on dark: indices where run i is dark.
    for (let i = 1; i + 4 < runs.length; i += 2) {
      const t = ratioOK(runs, i);
      if (!t) continue;
      const cx = starts[i + 2] + runs[i + 2] / 2;
      const cy = crossCheck(bin, w, h, Math.round(cx), y, runs[i + 2], true);
      if (cy < 0) continue;
      const cx2 = crossCheck(bin, w, h, Math.round(cx), Math.round(cy), runs[i + 2], false);
      if (cx2 < 0) continue;
      // Dense data regions produce h+v coincidences; a diagonal check through
      // the same center prunes nearly all of them.
      if (!crossCheckDiag(bin, w, h, Math.round(cx2), Math.round(cy), runs[i + 2])) continue;
      addCandidate(cands, cx2, cy, t);
    }
  }
  return cands.filter(c => c.count >= 2);
}

// Walk vertically (or horizontally) through (x,y) and verify 1:1:3:1:1; returns center or -1.
function crossCheck(bin, w, h, x, y, midRun, vertical) {
  const maxCount = midRun * 2 + 4;
  const get = vertical ? (i) => bin[i * w + x] : (i) => bin[y * w + i];
  const limit = vertical ? h : w;
  const start = vertical ? y : x;
  const counts = [0, 0, 0, 0, 0];
  let i = start;
  while (i >= 0 && get(i) === 1 && counts[2] <= maxCount) { counts[2]++; i--; }
  if (i < 0) return -1;
  while (i >= 0 && get(i) === 0 && counts[1] <= maxCount) { counts[1]++; i--; }
  while (i >= 0 && get(i) === 1 && counts[0] <= maxCount) { counts[0]++; i--; }
  const top = i;
  i = start + 1;
  while (i < limit && get(i) === 1 && counts[2] <= maxCount * 2) { counts[2]++; i++; }
  if (i >= limit) return -1;
  while (i < limit && get(i) === 0 && counts[3] <= maxCount) { counts[3]++; i++; }
  while (i < limit && get(i) === 1 && counts[4] <= maxCount) { counts[4]++; i++; }
  if (!ratioOK(counts, 0)) return -1;
  return i - counts[4] - counts[3] - counts[2] / 2;
}

// Verify 1:1:3:1:1 along the ↘ diagonal through (x,y).
function crossCheckDiag(bin, w, h, x, y, midRun) {
  const maxCount = midRun * 2 + 4;
  const at = (i) => {
    const px = x + i, py = y + i;
    if (px < 0 || py < 0 || px >= w || py >= h) return -1;
    return bin[py * w + px];
  };
  const counts = [0, 0, 0, 0, 0];
  let i = 0;
  while (at(i) === 1 && counts[2] <= maxCount) { counts[2]++; i--; }
  while (at(i) === 0 && counts[1] <= maxCount) { counts[1]++; i--; }
  while (at(i) === 1 && counts[0] <= maxCount) { counts[0]++; i--; }
  i = 1;
  while (at(i) === 1 && counts[2] <= maxCount * 2) { counts[2]++; i++; }
  while (at(i) === 0 && counts[3] <= maxCount) { counts[3]++; i++; }
  while (at(i) === 1 && counts[4] <= maxCount) { counts[4]++; i++; }
  return ratioOK(counts, 0) > 0;
}

function addCandidate(cands, x, y, moduleSize) {
  for (const c of cands) {
    if (Math.abs(c.x - x) < moduleSize * 3 && Math.abs(c.y - y) < moduleSize * 3) {
      c.x = (c.x * c.count + x) / (c.count + 1);
      c.y = (c.y * c.count + y) / (c.count + 1);
      c.moduleSize = (c.moduleSize * c.count + moduleSize) / (c.count + 1);
      c.count++;
      return;
    }
  }
  cands.push({ x, y, moduleSize, count: 1 });
}

// All candidate triples forming a right angle, best score first, with TL/TR/BL
// roles assigned. The caller validates them in order and keeps the first sane one.
function pickTriples(cands) {
  const out = [];
  if (cands.length < 3) return out;
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      for (let k = j + 1; k < cands.length; k++) {
        const tri = [cands[i], cands[j], cands[k]];
        // Similar module sizes required.
        const ms = tri.map(c => c.moduleSize);
        if (Math.max(...ms) > Math.min(...ms) * 1.8) continue;
        // TL = vertex not on the longest side (hypotenuse joins TR and BL).
        const d01 = dist2(tri[0], tri[1]), d02 = dist2(tri[0], tri[2]), d12 = dist2(tri[1], tri[2]);
        let a, b, c; // a = TL candidate
        if (d12 >= d01 && d12 >= d02) { a = tri[0]; b = tri[1]; c = tri[2]; }
        else if (d02 >= d01 && d02 >= d12) { a = tri[1]; b = tri[0]; c = tri[2]; }
        else { a = tri[2]; b = tri[0]; c = tri[1]; }
        // Right angle at TL, and legs of similar length.
        const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - a.x, y: c.y - a.y };
        const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
        if (l1 < 1 || l2 < 1 || l1 / l2 > 1.5 || l2 / l1 > 1.5) continue;
        const cosA = Math.abs(v1.x * v2.x + v1.y * v2.y) / (l1 * l2);
        if (cosA > 0.35) continue;
        const score = tri.reduce((s, t) => s + t.count, 0) - cosA * 10;
        // Orient: cross(TR-TL, BL-TL) must be > 0 in screen coords (y down).
        const cross = v1.x * v2.y - v1.y * v2.x;
        out.push(cross > 0
          ? { score, tl: a, tr: b, bl: c }
          : { score, tl: a, tr: c, bl: b });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
