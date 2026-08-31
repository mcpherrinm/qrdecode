// Save/load the whole session as one file: decoder state plus the original
// image bytes. Layout: "QRDS" magic, fmt u8, version u8, ec u8 (0 = auto,
// 1-4 = L/M/Q/H), mask u8 (0 = auto, 1-8), thrOffset i8, quietZone u8,
// imgW u32 LE, imgH u32 LE, warpPts 18 x f32 LE (row-major x,y), a 2-bit-per-
// module override plane (0 = auto, 1 = force white, 2 = force black,
// 3 = ignore), then u16 name length + UTF-8 name, u8 MIME length + ASCII MIME,
// u32 image length + image bytes. No compression: the image bytes dominate
// and are already compressed.
'use strict';

const STATEFILE_MAGIC = [0x51, 0x52, 0x44, 0x53]; // "QRDS"
const STATEFILE_FMT = 1;
const STATEFILE_HEAD = 18 + 72; // magic+fmt+fixed fields + warp points

// Cheap header check, for routing a file whose name doesn't end in .qrdecode.
function stateFileSniff(bytes) {
  return bytes.length >= 4 && STATEFILE_MAGIC.every((b, i) => bytes[i] === b);
}

function stateFileEncode(s, imgBytes, imgName, imgMime) {
  const size = 17 + 4 * s.version;
  const nameB = new TextEncoder().encode(imgName || '');
  const mimeB = new TextEncoder().encode(imgMime || '');
  const planeLen = Math.ceil(size * size / 4);
  const buf = new ArrayBuffer(STATEFILE_HEAD + planeLen +
    2 + nameB.length + 1 + mimeB.length + 4 + imgBytes.length);
  const dv = new DataView(buf);
  const out = new Uint8Array(buf);
  out.set(STATEFILE_MAGIC, 0);
  dv.setUint8(4, STATEFILE_FMT);
  dv.setUint8(5, s.version);
  dv.setUint8(6, s.ecOverride == null ? 0 : EC_INDEX[s.ecOverride] + 1);
  dv.setUint8(7, s.maskOverride == null ? 0 : s.maskOverride + 1);
  dv.setInt8(8, s.thrOffset);
  dv.setUint8(9, s.quietZone);
  dv.setUint32(10, s.imgW, true);
  dv.setUint32(14, s.imgH, true);
  let off = 18;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      dv.setFloat32(off, s.warpPts[i][j].x, true);
      dv.setFloat32(off + 4, s.warpPts[i][j].y, true);
      off += 8;
    }
  }
  for (const [idx, v] of s.overrides) {
    if (idx >= 0 && idx < size * size) {
      out[off + (idx >> 2)] |= (v + 1) << ((idx & 3) * 2);
    }
  }
  off += planeLen;
  dv.setUint16(off, nameB.length, true); off += 2;
  out.set(nameB, off); off += nameB.length;
  dv.setUint8(off, mimeB.length); off += 1;
  out.set(mimeB, off); off += mimeB.length;
  dv.setUint32(off, imgBytes.length, true); off += 4;
  out.set(imgBytes, off);
  return out;
}

function stateFileDecode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < STATEFILE_HEAD ||
      !STATEFILE_MAGIC.every((b, i) => bytes[i] === b) ||
      dv.getUint8(4) !== STATEFILE_FMT) {
    throw new Error('not a qrdecode state file');
  }
  const version = dv.getUint8(5);
  if (version < 1 || version > 40) throw new Error('bad version in state file');
  const size = 17 + 4 * version;
  const planeLen = Math.ceil(size * size / 4);
  const need = at => { if (bytes.length < at) throw new Error('truncated state file'); };
  need(STATEFILE_HEAD + planeLen + 2);
  const ecB = dv.getUint8(6), maskB = dv.getUint8(7);
  const s = {
    version,
    ecOverride: ecB ? EC_LEVELS[ecB - 1] : null,
    maskOverride: maskB ? maskB - 1 : null,
    thrOffset: dv.getInt8(8),
    quietZone: dv.getUint8(9),
    imgW: dv.getUint32(10, true),
    imgH: dv.getUint32(14, true),
    warpPts: [],
    overrides: [],
  };
  let off = 18;
  for (let i = 0; i < 3; i++) {
    const row = [];
    for (let j = 0; j < 3; j++) {
      row.push({ x: dv.getFloat32(off, true), y: dv.getFloat32(off + 4, true) });
      off += 8;
    }
    s.warpPts.push(row);
  }
  for (let idx = 0; idx < size * size; idx++) {
    const v = (bytes[off + (idx >> 2)] >> ((idx & 3) * 2)) & 3;
    if (v) s.overrides.push([idx, v - 1]);
  }
  off += planeLen;
  const nameLen = dv.getUint16(off, true); off += 2;
  need(off + nameLen + 1);
  const name = new TextDecoder().decode(bytes.subarray(off, off + nameLen)); off += nameLen;
  const mimeLen = dv.getUint8(off); off += 1;
  need(off + mimeLen + 4);
  const mime = new TextDecoder().decode(bytes.subarray(off, off + mimeLen)); off += mimeLen;
  const imgLen = dv.getUint32(off, true); off += 4;
  need(off + imgLen);
  return { ...s, image: { bytes: bytes.subarray(off, off + imgLen), name, mime } };
}
