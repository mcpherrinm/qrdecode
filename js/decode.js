// Decode pipeline: bit matrix -> format -> codewords -> RS blocks -> bitstream text.
// Everything keeps bit/byte -> module mappings so the UI can cross-highlight.
'use strict';

class DecErr extends Error {}

// getBit(r, c) => 0/1 (1 = dark). Returns a rich result object; never throws.
function decodeMatrix(getBit, version, opts = {}) {
  const layout = getLayout(version);
  const size = layout.size;

  const format = decodeFormat(getBit, size);
  const ec = opts.ecOverride || format.ec;
  const mask = opts.maskOverride != null ? opts.maskOverride : format.mask;
  const versionInfo = decodeVersionInfo(getBit, size);

  // Unmask and pack data modules into codewords.
  const maskFn = MASKS[mask];
  const order = layout.order;
  const numCw = order.length >> 3;
  const cwRaw = new Uint8Array(numCw);
  for (let i = 0; i < numCw; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) {
      const idx = order[i * 8 + j];
      const r = (idx / size) | 0, c = idx % size;
      v = (v << 1) | (getBit(r, c) ^ (maskFn(r, c) ? 1 : 0));
    }
    cwRaw[i] = v;
  }

  const struct = blockStructure(version, ec);
  // Codeword metadata, indexed by global (interleaved) codeword index.
  const cw = new Array(struct.total);
  const blocks = [];
  const streamBytes = [];   // corrected (or raw, if block failed) data bytes in stream order
  const streamToGlobal = [];
  const streamBlock = [];

  for (let b = 0; b < struct.blocks.length; b++) {
    const blk = struct.blocks[b];
    const globals = blk.dataGlobal.concat(blk.ecGlobal);
    const msg = globals.map(g => cwRaw[g] || 0);
    const res = rsDecode(msg, struct.ecPer);
    const fixed = new Set(res.errors);
    const info = {
      index: b,
      status: res.ok ? (res.errors.length ? 'fixed' : 'clean') : 'fail',
      fixedCount: res.errors.length,
      dataGlobal: blk.dataGlobal,
      ecGlobal: blk.ecGlobal,
      globals,
    };
    blocks.push(info);
    for (let j = 0; j < globals.length; j++) {
      const g = globals[j];
      const modules = [];
      for (let k = 0; k < 8; k++) modules.push(order[g * 8 + k]);
      cw[g] = {
        g,
        raw: cwRaw[g] || 0,
        val: res.ok ? res.out[j] : (cwRaw[g] || 0),
        fixed: res.ok && fixed.has(j),
        isEC: j >= blk.numData,
        block: b,
        modules,
      };
    }
    for (let j = 0; j < blk.numData; j++) {
      streamBytes.push(cw[blk.dataGlobal[j]].val);
      streamToGlobal.push(blk.dataGlobal[j]);
      streamBlock.push(b);
    }
  }

  const parsed = parseBitstream(Uint8Array.from(streamBytes), version);
  // A character is suspect if any byte it came from is in a failed block, or if its
  // segment's header (mode + count) is — a damaged header misframes everything after it.
  const bitRangeSuspect = (start, end) => {
    const b0 = start >> 3, b1 = (end - 1) >> 3;
    for (let k = b0; k <= b1 && k < streamBlock.length; k++) {
      if (blocks[streamBlock[k]].status === 'fail') return true;
    }
    return false;
  };
  for (const ch of parsed.chars) {
    const seg = parsed.segments[ch.seg];
    ch.suspect = bitRangeSuspect(ch.start, ch.end) ||
      (seg && seg.headerEnd > seg.start && bitRangeSuspect(seg.start, seg.headerEnd));
  }

  // Module index -> global codeword index (data area only), for canvas hover.
  const moduleToCw = new Int32Array(size * size).fill(-1);
  for (let g = 0; g < struct.total; g++) {
    if (cw[g]) for (const mIdx of cw[g].modules) moduleToCw[mIdx] = g;
  }

  return {
    version, size, ec, mask, format, versionInfo,
    formatOverridden: !!(opts.ecOverride || opts.maskOverride != null),
    cw, blocks, moduleToCw,
    stream: { bytes: streamBytes, toGlobal: streamToGlobal, block: streamBlock },
    parsed,
    ecPer: struct.ecPer,
  };
}

// Modules (as r*size+c indices) covered by a data-stream bit range [start, end).
function modulesForBitRange(result, start, end) {
  const out = [];
  for (let bit = start; bit < end; bit++) {
    const byteIdx = bit >> 3;
    if (byteIdx >= result.stream.toGlobal.length) break;
    const g = result.stream.toGlobal[byteIdx];
    out.push(result.cw[g].modules[bit & 7]);
  }
  return out;
}

// Global codeword indices covered by a data-stream bit range.
function codewordsForBitRange(result, start, end) {
  const set = new Set();
  for (let k = start >> 3; k <= (end - 1) >> 3; k++) {
    if (k < result.stream.toGlobal.length) set.add(result.stream.toGlobal[k]);
  }
  return [...set];
}

// Parse the data bitstream into segments and characters with bit-range provenance.
function parseBitstream(bytes, version) {
  const totalBits = bytes.length * 8;
  let pos = 0;
  function read(n) {
    if (pos + n > totalBits) throw new DecErr('ran out of data bits');
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
      pos++;
    }
    return v;
  }

  const segments = [];
  const chars = []; // {ch, start, end, seg}
  let error = null;
  let eci = null;

  try {
    while (totalBits - pos >= 4) {
      const segStart = pos;
      const mode = read(4);
      if (mode === 0) {
        segments.push({ mode: 'END', start: segStart, end: pos, count: 0 });
        break;
      }
      const segIdx = segments.length;
      if (mode === 1) { // numeric
        const cc = read(ccBits(1, version));
        const headerEnd = pos;
        let rem = cc;
        while (rem > 0) {
          const k = Math.min(3, rem);
          const bits = k === 3 ? 10 : k === 2 ? 7 : 4;
          const s = pos;
          const v = read(bits);
          if (v >= 10 ** k) throw new DecErr(`numeric group ${v} out of range at bit ${s}`);
          const str = String(v).padStart(k, '0');
          for (const ch of str) chars.push({ ch, start: s, end: pos, seg: segIdx });
          rem -= k;
        }
        segments.push({ mode: 'NUM', count: cc, start: segStart, end: pos, headerEnd });
      } else if (mode === 2) { // alphanumeric
        const cc = read(ccBits(2, version));
        const headerEnd = pos;
        let rem = cc;
        while (rem > 0) {
          const k = Math.min(2, rem);
          const s = pos;
          const v = read(k === 2 ? 11 : 6);
          if (k === 2) {
            if (v >= 45 * 45) throw new DecErr(`alnum pair ${v} out of range at bit ${s}`);
            chars.push({ ch: ALNUM_CHARS[(v / 45) | 0], start: s, end: pos, seg: segIdx });
            chars.push({ ch: ALNUM_CHARS[v % 45], start: s, end: pos, seg: segIdx });
          } else {
            if (v >= 45) throw new DecErr(`alnum char ${v} out of range at bit ${s}`);
            chars.push({ ch: ALNUM_CHARS[v], start: s, end: pos, seg: segIdx });
          }
          rem -= k;
        }
        segments.push({ mode: 'ALNUM', count: cc, start: segStart, end: pos, headerEnd });
      } else if (mode === 4) { // byte
        const cc = read(ccBits(4, version));
        const headerEnd = pos;
        const spans = [];
        for (let i = 0; i < cc; i++) {
          const s = pos;
          const v = read(8);
          spans.push({ v, s, e: pos });
        }
        decodeByteSpans(spans, eci, segIdx, chars);
        segments.push({ mode: 'BYTE', count: cc, start: segStart, end: pos, eci, headerEnd });
      } else if (mode === 8) { // kanji
        const cc = read(ccBits(8, version));
        const headerEnd = pos;
        for (let i = 0; i < cc; i++) {
          const s = pos;
          const v = read(13);
          let sj = (((v / 0xc0) | 0) << 8) | (v % 0xc0);
          sj += sj < 0x1f00 ? 0x8140 : 0xc140;
          chars.push({ ch: decodeShiftJIS(sj), start: s, end: pos, seg: segIdx });
        }
        segments.push({ mode: 'KANJI', count: cc, start: segStart, end: pos, headerEnd });
      } else if (mode === 7) { // ECI
        const first = read(8);
        let val;
        if ((first & 0x80) === 0) val = first & 0x7f;
        else if ((first & 0xc0) === 0x80) val = ((first & 0x3f) << 8) | read(8);
        else if ((first & 0xe0) === 0xc0) val = ((first & 0x1f) << 16) | read(16);
        else throw new DecErr(`bad ECI header at bit ${segStart}`);
        eci = val;
        segments.push({ mode: 'ECI', value: val, count: 0, start: segStart, end: pos });
      } else if (mode === 3) { // structured append
        const seq = read(8), parity = read(8);
        segments.push({ mode: 'SA', seq, parity, count: 0, start: segStart, end: pos });
      } else if (mode === 5 || mode === 9) { // FNC1
        segments.push({ mode: mode === 5 ? 'FNC1-1' : 'FNC1-2', count: 0, start: segStart, end: pos });
        if (mode === 9) read(8);
      } else {
        throw new DecErr(`unknown mode ${mode.toString(2).padStart(4, '0')} at bit ${segStart}`);
      }
    }
  } catch (e) {
    if (e instanceof DecErr) error = e.message;
    else throw e;
  }

  return { chars, segments, error, text: chars.map(c => c.ch).join('') };
}

// Decode byte-mode spans as UTF-8 when valid (or forced by ECI 26); fall back to Latin-1.
function decodeByteSpans(spans, eci, segIdx, chars) {
  const wantUtf8 = eci === 26 || eci == null;
  if (wantUtf8) {
    const recs = [];
    let i = 0, ok = true;
    while (i < spans.length) {
      const b = spans[i].v;
      let len = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 0;
      if (len === 0 || i + len > spans.length) { ok = false; break; }
      let cp = len === 1 ? b : b & (0x7f >> len);
      let valid = true;
      for (let j = 1; j < len; j++) {
        const cb = spans[i + j].v;
        if ((cb & 0xc0) !== 0x80) { valid = false; break; }
        cp = (cp << 6) | (cb & 0x3f);
      }
      if (!valid || cp > 0x10ffff || (len > 1 && cp < 0x80)) { ok = false; break; }
      recs.push({ ch: String.fromCodePoint(cp), start: spans[i].s, end: spans[i + len - 1].e, seg: segIdx });
      i += len;
    }
    if (ok) { chars.push(...recs); return; }
    if (eci === 26) {
      // Forced UTF-8 but invalid: emit per-byte replacement so damage stays visible.
      for (const sp of spans) chars.push({ ch: sp.v < 0x80 ? String.fromCharCode(sp.v) : '�', start: sp.s, end: sp.e, seg: segIdx });
      return;
    }
  }
  for (const sp of spans) chars.push({ ch: String.fromCharCode(sp.v), start: sp.s, end: sp.e, seg: segIdx });
}

let sjisDecoder;
function decodeShiftJIS(code) {
  try {
    if (sjisDecoder === undefined) {
      sjisDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('shift_jis') : null;
    }
    if (sjisDecoder) {
      return sjisDecoder.decode(new Uint8Array([code >> 8, code & 0xff]));
    }
  } catch (e) { /* fall through */ }
  return '〓'; // geta mark placeholder
}
