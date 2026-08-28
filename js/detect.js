// Finder-pattern detection: locate the three 1:1:3:1:1 squares and estimate
// the symbol's corners and version. Best-effort — the human refines the rest.
'use strict';

// imageData at (possibly reduced) scale. Returns null or
// {corners: [TL,TR,BR,BL] image coords, version, moduleSize}.
function detectQR(imageData) {
  const w = imageData.width, h = imageData.height;
  const gray = toGray(imageData);
  const bin = binarize(gray, w, h);
  const cands = findFinderCandidates(bin, w, h);
  if (cands.length < 3) return null;

  cands.sort((a, b) => b.count - a.count);
  let best = pickTriple(cands.slice(0, 8));
  if (!best) return null;
  const { tl, tr, bl } = best;

  const msize = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3;
  const distTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const distLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  let dim = Math.round(((distTop + distLeft) / 2) / msize) + 7;
  dim = Math.max(21, Math.min(177, dim));
  // Snap to nearest valid dimension (== 21 mod 4, within [21, 177]).
  const rem = (dim - 21) % 4;
  if (rem !== 0) dim += rem <= 2 ? -rem : 4 - rem;
  dim = Math.max(21, Math.min(177, dim));
  const version = (dim - 17) / 4;

  // Per-module basis vectors from the finder centers.
  const span = dim - 7;
  const ex = { x: (tr.x - tl.x) / span, y: (tr.y - tl.y) / span };
  const ey = { x: (bl.x - tl.x) / span, y: (bl.y - tl.y) / span };
  const at = (p, mx, my) => ({ x: p.x + ex.x * mx + ey.x * my, y: p.y + ex.y * mx + ey.y * my });
  const cTL = at(tl, -3.5, -3.5);
  const cTR = at(tr, 3.5, -3.5);
  const cBL = at(bl, -3.5, 3.5);
  const cBR = { x: cTR.x + cBL.x - cTL.x, y: cTR.y + cBL.y - cTL.y };
  return { corners: [cTL, cTR, cBR, cBL], version, moduleSize: msize };
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
function binarize(gray, w, h) {
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
      const t = mean * 0.85 + globalT * 0.15;
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

// Choose 3 candidates forming a right angle and assign TL/TR/BL roles.
function pickTriple(cands) {
  if (cands.length < 3) return null;
  let best = null;
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
        if (!best || score > best.score) {
          // Orient: cross(TR-TL, BL-TL) must be > 0 in screen coords (y down).
          const cross = v1.x * v2.y - v1.y * v2.x;
          best = cross > 0
            ? { score, tl: a, tr: b, bl: c }
            : { score, tl: a, tr: c, bl: b };
        }
      }
    }
  }
  return best;
}

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
