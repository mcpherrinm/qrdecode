// GF(256) arithmetic (poly 0x11D) and Reed-Solomon decoding for QR codes.
'use strict';

const GF = (() => {
  const EXP = new Uint8Array(512);
  const LOG = new Int16Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  function inv(a) {
    return EXP[255 - LOG[a]];
  }
  return { EXP, LOG, mul, inv };
})();

// Decode one RS(n, n-nsym) codeword block. msgIn = data||ec bytes, nsym = #ec bytes.
// Returns {ok, out, errors} where errors = corrected byte positions (0 = first byte).
function rsDecode(msgIn, nsym) {
  const { EXP, LOG, mul, inv } = GF;
  const n = msgIn.length;
  const msg = Array.from(msgIn);

  // Syndromes s_k = M(alpha^k), k = 0..nsym-1 (QR uses fcr=0).
  const synd = new Array(nsym);
  let allZero = true;
  for (let k = 0; k < nsym; k++) {
    let s = 0;
    const ak = EXP[k % 255];
    for (let i = 0; i < n; i++) s = mul(s, ak) ^ msg[i];
    synd[k] = s;
    if (s !== 0) allZero = false;
  }
  if (allZero) return { ok: true, out: msg, errors: [] };

  // Berlekamp–Massey: find error locator polynomial C (ascending powers).
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let step = 0; step < nsym; step++) {
    let d = synd[step];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, synd[step - i]);
    if (d === 0) {
      m++;
    } else if (2 * L <= step) {
      const T = C.slice();
      const coef = mul(d, inv(b));
      for (let i = 0; i < B.length; i++) C[i + m] = (C[i + m] || 0) ^ mul(coef, B[i]);
      L = step + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      const coef = mul(d, inv(b));
      for (let i = 0; i < B.length; i++) C[i + m] = (C[i + m] || 0) ^ mul(coef, B[i]);
      m++;
    }
  }
  if (2 * L > nsym) return { ok: false, out: msg, errors: [] };

  // Chien search: byte i corresponds to power p = n-1-i; root when C(alpha^-p) = 0.
  const errPos = [];
  for (let i = 0; i < n; i++) {
    const p = n - 1 - i;
    const xinv = (255 - (p % 255)) % 255;
    let sum = 0;
    for (let k = 0; k < C.length; k++) {
      const ck = C[k] || 0;
      if (ck !== 0) sum ^= EXP[(LOG[ck] + k * xinv) % 255];
    }
    if (sum === 0) errPos.push(i);
  }
  if (errPos.length !== L) return { ok: false, out: msg, errors: [] };

  // Solve for error magnitudes: sum_j e_j * alpha^(k*p_j) = synd[k], k = 0..L-1.
  const A = [];
  for (let k = 0; k < L; k++) {
    const row = new Array(L + 1);
    for (let j = 0; j < L; j++) {
      const p = n - 1 - errPos[j];
      row[j] = EXP[(k * p) % 255];
    }
    row[L] = synd[k];
    A.push(row);
  }
  const mags = gfSolve(A, L);
  if (!mags) return { ok: false, out: msg, errors: [] };
  for (let j = 0; j < L; j++) msg[errPos[j]] ^= mags[j];

  // Verify: all syndromes must now be zero.
  for (let k = 0; k < nsym; k++) {
    let s = 0;
    const ak = EXP[k % 255];
    for (let i = 0; i < n; i++) s = mul(s, ak) ^ msg[i];
    if (s !== 0) return { ok: false, out: Array.from(msgIn), errors: [] };
  }
  return { ok: true, out: msg, errors: errPos };
}

// Gaussian elimination over GF(256); A is L rows of L+1 (augmented). Returns solution or null.
function gfSolve(A, L) {
  const { mul, inv } = GF;
  for (let col = 0; col < L; col++) {
    let piv = -1;
    for (let r = col; r < L; r++) if (A[r][col] !== 0) { piv = r; break; }
    if (piv < 0) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    const invP = inv(A[col][col]);
    for (let j = col; j <= L; j++) A[col][j] = mul(A[col][j], invP);
    for (let r = 0; r < L; r++) {
      if (r === col || A[r][col] === 0) continue;
      const f = A[r][col];
      for (let j = col; j <= L; j++) A[r][j] ^= mul(f, A[col][j]);
    }
  }
  return A.map(row => row[L]);
}
