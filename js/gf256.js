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
// erasePos = byte positions known to be unreliable (erasures). RS can correct
// e errors + f erasures when 2e + f <= nsym, so known-location damage costs half.
// Returns {ok, out, errors, erasures}: errors = corrected unknown-position bytes,
// erasures = erasure positions whose byte actually changed (0 = first byte).
function rsDecode(msgIn, nsym, erasePos = []) {
  const { EXP, LOG, mul, inv } = GF;
  const n = msgIn.length;
  const msg = Array.from(msgIn);
  const fail = () => ({ ok: false, out: Array.from(msgIn), errors: [], erasures: [] });
  const erase = [...new Set(erasePos)].filter(p => p >= 0 && p < n);
  const f = erase.length;
  if (f > nsym) return fail();

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
  if (allZero) return { ok: true, out: msg, errors: [], erasures: [] };

  // Erasure locator Γ(x) = Π (1 + alpha^p x), p = n-1-pos (ascending powers).
  let gamma = [1];
  for (const pos of erase) {
    const ap = EXP[(n - 1 - pos) % 255];
    const next = new Array(gamma.length + 1).fill(0);
    for (let i = 0; i < gamma.length; i++) {
      next[i] ^= gamma[i];
      next[i + 1] ^= mul(gamma[i], ap);
    }
    gamma = next;
  }

  // Modified (Forney) syndromes T = S·Γ mod x^nsym; the tail T[f..] obeys the
  // recurrence of the unknown-error locator alone.
  const tSynd = new Array(nsym);
  for (let k = 0; k < nsym; k++) {
    let s = 0;
    for (let i = 0; i <= Math.min(k, f); i++) s ^= mul(gamma[i] || 0, synd[k - i]);
    tSynd[k] = s;
  }
  const u = tSynd.slice(f); // syndrome sequence for BM, length nsym - f

  // Berlekamp–Massey on u: find unknown-error locator polynomial C (ascending).
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let step = 0; step < u.length; step++) {
    let d = u[step];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, u[step - i]);
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
  if (2 * L > nsym - f) return fail();

  // Chien search: byte i corresponds to power p = n-1-i; root when C(alpha^-p) = 0.
  const errPos = [];
  if (L > 0) {
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
    if (errPos.length !== L) return fail();
  }

  // Solve magnitudes over all positions (erasures + errors) against the original
  // syndromes: sum_j e_j * alpha^(k*p_j) = synd[k], k = 0..P-1.
  const pos = [...new Set([...erase, ...errPos])].sort((a, c) => a - c);
  const P = pos.length;
  if (P === 0 || P > nsym) return fail();
  const A = [];
  for (let k = 0; k < P; k++) {
    const row = new Array(P + 1);
    for (let j = 0; j < P; j++) {
      const p = n - 1 - pos[j];
      row[j] = EXP[(k * p) % 255];
    }
    row[P] = synd[k];
    A.push(row);
  }
  const mags = gfSolve(A, P);
  if (!mags) return fail();
  for (let j = 0; j < P; j++) msg[pos[j]] ^= mags[j];

  // Verify: all syndromes must now be zero.
  for (let k = 0; k < nsym; k++) {
    let s = 0;
    const ak = EXP[k % 255];
    for (let i = 0; i < n; i++) s = mul(s, ak) ^ msg[i];
    if (s !== 0) return fail();
  }
  const eraseSet = new Set(erase);
  return {
    ok: true, out: msg,
    errors: pos.filter(p => !eraseSet.has(p)),
    erasures: pos.filter(p => eraseSet.has(p) && msg[p] !== msgIn[p]),
  };
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
