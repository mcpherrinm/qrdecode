// Symbol layout: function-pattern map and data-module read order per version.
'use strict';

const layoutCache = new Map();

function getLayout(version) {
  if (layoutCache.has(version)) return layoutCache.get(version);
  const size = 17 + 4 * version;
  const isF = new Uint8Array(size * size);
  // Expected value of spec-fixed modules: -1 unknown/data, 0 light, 1 dark.
  // (Format/version info areas stay -1 here — their expectation depends on the
  // decoded EC level and mask, handled separately.)
  const expected = new Int8Array(size * size).fill(-1);
  const mark = (r, c, exp) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      isF[r * size + c] = 1;
      if (exp !== undefined) expected[r * size + c] = exp;
    }
  };

  // Finder patterns + separators (8x8 regions in three corners).
  // Within the 7x7 finder, chebyshev distance 2 from center is the light ring.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const d = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const exp = d <= 3 ? (d === 2 ? 0 : 1) : 0; // d==4 row/col 7 = separator, light
      mark(r, c, exp);
      mark(r, size - 1 - c, exp);
      mark(size - 1 - r, c, exp);
    }
  }
  // Timing patterns: dark on even coordinates.
  for (let i = 8; i < size - 8; i++) {
    mark(6, i, i % 2 === 0 ? 1 : 0);
    mark(i, 6, i % 2 === 0 ? 1 : 0);
  }
  // Alignment patterns (5x5), skipping the three that would overlap finders.
  const ap = alignmentPositions(version);
  for (const rc of ap) {
    for (const cc of ap) {
      const inFinder =
        (rc <= 7 && cc <= 7) || (rc <= 7 && cc >= size - 8) || (rc >= size - 8 && cc <= 7);
      if (inFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const d = Math.max(Math.abs(dr), Math.abs(dc));
          mark(rc + dr, cc + dc, d === 1 ? 0 : 1);
        }
      }
    }
  }
  // Format info areas + dark module.
  for (let i = 0; i <= 8; i++) { mark(i, 8); mark(8, i); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  expected[(size - 8) * size + 8] = 1; // dark module, always dark
  // Version info areas (v >= 7).
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      for (const [r, c] of versionBitPositions(size, i)) mark(r, c);
    }
  }

  // Data-module read order: two-column zigzag from bottom-right, skipping col 6.
  const order = [];
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!isF[row * size + c]) order.push(row * size + c);
      }
    }
    upward = !upward;
  }

  const layout = { version, size, isF, expected, order, alignment: ap };
  layoutCache.set(version, layout);
  return layout;
}
