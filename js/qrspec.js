// QR code specification tables and small codecs (ISO/IEC 18004).
'use strict';

// Error-correction block structure per version. [L, M, Q, H], each entry:
// [ecCodewordsPerBlock, numBlocks1, dataCodewords1, numBlocks2, dataCodewords2]
const EC_TABLE = [null,
/* 1*/ [[7,1,19,0,0],[10,1,16,0,0],[13,1,13,0,0],[17,1,9,0,0]],
/* 2*/ [[10,1,34,0,0],[16,1,28,0,0],[22,1,22,0,0],[28,1,16,0,0]],
/* 3*/ [[15,1,55,0,0],[26,1,44,0,0],[18,2,17,0,0],[22,2,13,0,0]],
/* 4*/ [[20,1,80,0,0],[18,2,32,0,0],[26,2,24,0,0],[16,4,9,0,0]],
/* 5*/ [[26,1,108,0,0],[24,2,43,0,0],[18,2,15,2,16],[22,2,11,2,12]],
/* 6*/ [[18,2,68,0,0],[16,4,27,0,0],[24,4,19,0,0],[28,4,15,0,0]],
/* 7*/ [[20,2,78,0,0],[18,4,31,0,0],[18,2,14,4,15],[26,4,13,1,14]],
/* 8*/ [[24,2,97,0,0],[22,2,38,2,39],[22,4,18,2,19],[26,4,14,2,15]],
/* 9*/ [[30,2,116,0,0],[22,3,36,2,37],[20,4,16,4,17],[24,4,12,4,13]],
/*10*/ [[18,2,68,2,69],[26,4,43,1,44],[24,6,19,2,20],[28,6,15,2,16]],
/*11*/ [[20,4,81,0,0],[30,1,50,4,51],[28,4,22,4,23],[24,3,12,8,13]],
/*12*/ [[24,2,92,2,93],[22,6,36,2,37],[26,4,20,6,21],[28,7,14,4,15]],
/*13*/ [[26,4,107,0,0],[22,8,37,1,38],[24,8,20,4,21],[22,12,11,4,12]],
/*14*/ [[30,3,115,1,116],[24,4,40,5,41],[20,11,16,5,17],[24,11,12,5,13]],
/*15*/ [[22,5,87,1,88],[24,5,41,5,42],[30,5,24,7,25],[24,11,12,7,13]],
/*16*/ [[24,5,98,1,99],[28,7,45,3,46],[24,15,19,2,20],[30,3,15,13,16]],
/*17*/ [[28,1,107,5,108],[28,10,46,1,47],[28,1,22,15,23],[28,2,14,17,15]],
/*18*/ [[30,5,120,1,121],[26,9,43,4,44],[28,17,22,1,23],[28,2,14,19,15]],
/*19*/ [[28,3,113,4,114],[26,3,44,11,45],[26,17,21,4,22],[26,9,13,16,14]],
/*20*/ [[28,3,107,5,108],[26,3,41,13,42],[30,15,24,5,25],[28,15,15,10,16]],
/*21*/ [[28,4,116,4,117],[26,17,42,0,0],[28,17,22,6,23],[30,19,16,6,17]],
/*22*/ [[28,2,111,7,112],[28,17,46,0,0],[30,7,24,16,25],[24,34,13,0,0]],
/*23*/ [[30,4,121,5,122],[28,4,47,14,48],[30,11,24,14,25],[30,16,15,14,16]],
/*24*/ [[30,6,117,4,118],[28,6,45,14,46],[30,11,24,16,25],[30,30,16,2,17]],
/*25*/ [[26,8,106,4,107],[28,8,47,13,48],[30,7,24,22,25],[30,22,15,13,16]],
/*26*/ [[28,10,114,2,115],[28,19,46,4,47],[28,28,22,6,23],[30,33,16,4,17]],
/*27*/ [[30,8,122,4,123],[28,22,45,3,46],[30,8,23,26,24],[30,12,15,28,16]],
/*28*/ [[30,3,117,10,118],[28,3,45,23,46],[30,4,24,31,25],[30,11,15,31,16]],
/*29*/ [[30,7,116,7,117],[28,21,45,7,46],[30,1,23,37,24],[30,19,15,26,16]],
/*30*/ [[30,5,115,10,116],[28,19,47,10,48],[30,15,24,25,25],[30,23,15,25,16]],
/*31*/ [[30,13,115,3,116],[28,2,46,29,47],[30,42,24,1,25],[30,23,15,28,16]],
/*32*/ [[30,17,115,0,0],[28,10,46,23,47],[30,10,24,35,25],[30,19,15,35,16]],
/*33*/ [[30,17,115,1,116],[28,14,46,21,47],[30,29,24,19,25],[30,11,15,46,16]],
/*34*/ [[30,13,115,6,116],[28,14,46,23,47],[30,44,24,7,25],[30,59,16,1,17]],
/*35*/ [[30,12,121,7,122],[28,12,47,26,48],[30,39,24,14,25],[30,22,15,41,16]],
/*36*/ [[30,6,121,14,122],[28,6,47,34,48],[30,46,24,10,25],[30,2,15,64,16]],
/*37*/ [[30,17,122,4,123],[28,29,46,14,47],[30,49,24,10,25],[30,24,15,46,16]],
/*38*/ [[30,4,122,18,123],[28,13,46,32,47],[30,48,24,14,25],[30,42,15,32,16]],
/*39*/ [[30,20,117,4,118],[28,40,47,7,48],[30,43,24,22,25],[30,10,15,67,16]],
/*40*/ [[30,19,118,6,119],[28,18,47,31,48],[30,34,24,34,25],[30,20,15,61,16]],
];

const EC_LEVELS = ['L', 'M', 'Q', 'H'];
const EC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
// Format-info encoding of the EC level (2 bits).
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const EC_FROM_FORMAT_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

// Mask predicates: true => flip the module.
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => ((r >> 1) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Character-count field width by mode and version.
function ccBits(mode, version) {
  const idx = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const table = { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16], 8: [8, 10, 12] };
  return table[mode][idx];
}

const ALNUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// 15-bit format info: 5 data bits (ec|mask) + 10 BCH bits, XORed with 0x5412.
function encodeFormatBits(ecLevel, mask) {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// 18-bit version info: 6 data bits + 12 BCH bits (versions >= 7 only).
function encodeVersionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

// Module coordinates [row, col] of format-info bit i (0 = LSB) for both copies.
function formatBitPositions(size) {
  const copy1 = [], copy2 = [];
  for (let i = 0; i <= 5; i++) copy1.push([i, 8]);
  copy1.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i <= 14; i++) copy1.push([8, 14 - i]);
  for (let i = 0; i <= 7; i++) copy2.push([8, size - 1 - i]);
  for (let i = 8; i <= 14; i++) copy2.push([size - 15 + i, 8]);
  return { copy1, copy2 };
}

// Module coordinates of version-info bit i (0 = LSB): [topRight, bottomLeft].
function versionBitPositions(size, i) {
  const a = size - 11 + (i % 3);
  const b = Math.floor(i / 3);
  return [[b, a], [a, b]];
}

// Best-match decode of format info from sampled bits. getBit(r,c) => 0/1.
// Returns {ec, mask, distance} with distance = summed hamming distance of both copies.
function decodeFormat(getBit, size) {
  const { copy1, copy2 } = formatBitPositions(size);
  let f1 = 0, f2 = 0;
  for (let i = 0; i < 15; i++) {
    if (getBit(copy1[i][0], copy1[i][1])) f1 |= 1 << i;
    if (getBit(copy2[i][0], copy2[i][1])) f2 |= 1 << i;
  }
  let best = null;
  for (const ec of EC_LEVELS) {
    for (let mask = 0; mask < 8; mask++) {
      const pat = encodeFormatBits(ec, mask);
      const d = popcount(pat ^ f1) + popcount(pat ^ f2);
      if (!best || d < best.distance) best = { ec, mask, distance: d };
    }
  }
  return best;
}

// Best-match decode of version info (only meaningful when assumed size >= 45).
function decodeVersionInfo(getBit, size) {
  if (size < 45) return null;
  let vTR = 0, vBL = 0;
  for (let i = 0; i < 18; i++) {
    const [tr, bl] = versionBitPositions(size, i);
    if (getBit(tr[0], tr[1])) vTR |= 1 << i;
    if (getBit(bl[0], bl[1])) vBL |= 1 << i;
  }
  let best = null;
  for (let v = 7; v <= 40; v++) {
    const pat = encodeVersionBits(v);
    const d = popcount(pat ^ vTR) + popcount(pat ^ vBL);
    if (!best || d < best.distance) best = { version: v, distance: d };
  }
  return best;
}

// Alignment pattern center coordinates (Nayuki's closed form; matches Annex E table).
function alignmentPositions(version) {
  if (version === 1) return [];
  const size = 17 + 4 * version;
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 :
    Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// Interleaved block structure. Returns per-block lists of global codeword indices.
function blockStructure(version, ecLevel) {
  const [ecPer, n1, dc1, n2, dc2] = EC_TABLE[version][EC_INDEX[ecLevel]];
  const blocks = [];
  for (let i = 0; i < n1; i++) blocks.push({ numData: dc1, dataGlobal: [], ecGlobal: [] });
  for (let i = 0; i < n2; i++) blocks.push({ numData: dc2, dataGlobal: [], ecGlobal: [] });
  const maxD = Math.max(dc1, dc2);
  let g = 0;
  for (let j = 0; j < maxD; j++)
    for (const b of blocks) if (j < b.numData) b.dataGlobal.push(g++);
  for (let j = 0; j < ecPer; j++)
    for (const b of blocks) b.ecGlobal.push(g++);
  const totalData = n1 * dc1 + n2 * dc2;
  return { blocks, ecPer, totalData, total: g };
}
