// Projective mapping between grid space (u,v in [0,size]) and image-pixel space.
'use strict';

// corners = [TL, TR, BR, BL] as {x, y}; maps the size x size grid square onto that quad.
// Returns a 3x3 row-major matrix H such that (x,y) ~ H * (u/size, v/size, 1).
function squareToQuad(corners, size) {
  const [p0, p1, p2, p3] = corners; // TL, TR, BR, BL for unit square (0,0)(1,0)(1,1)(0,1)
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = p1.x - p0.x; b = p2.x - p1.x; c = p0.x;
    d = p1.y - p0.y; e = p2.y - p1.y; f = p0.y;
    g = 0; h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + h * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + h * p3.y;
    f = p0.y;
  }
  // Compose with scale (u,v) -> (u/size, v/size).
  const s = 1 / size;
  return [a * s, b * s, c, d * s, e * s, f, g * s, h * s, 1];
}

function applyH(H, u, v) {
  const w = H[6] * u + H[7] * v + H[8];
  return {
    x: (H[0] * u + H[1] * v + H[2]) / w,
    y: (H[3] * u + H[4] * v + H[5]) / w,
  };
}

// Flat (projective) mapper: 4 corners.
function makeFlatMap(corners, size) {
  const H = squareToQuad(corners, size);
  const Hi = invertH(H);
  return {
    warped: false,
    map: (u, v) => applyH(H, u, v),
    unmap: (x, y) => applyH(Hi, x, y),
  };
}

// Warped mapper: 3x3 interpolating control points for curved surfaces.
// pts[i][j] = image position of grid point (u = j*size/2, v = i*size/2); the
// surface passes exactly through all nine points (biquadratic Lagrange).
function makeWarpMap(pts, size) {
  const L = t => [2 * (t - 0.5) * (t - 1), -4 * t * (t - 1), 2 * t * (t - 0.5)];
  const dL = t => [4 * t - 3, -8 * t + 4, 4 * t - 1];

  function map(u, v) {
    const Ls = L(u / size), Lt = L(v / size);
    let x = 0, y = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const w = Lt[i] * Ls[j];
        x += pts[i][j].x * w;
        y += pts[i][j].y * w;
      }
    }
    return { x, y };
  }

  // Inverse via Newton iteration, seeded by the flat homography of the corner quad.
  const cornerQuad = [pts[0][0], pts[0][2], pts[2][2], pts[2][0]];
  const Hi = invertH(squareToQuad(cornerQuad, size));
  function unmap(x, y) {
    const g0 = applyH(Hi, x, y);
    let s = g0.x / size, t = g0.y / size;
    for (let iter = 0; iter < 10; iter++) {
      const Ls = L(s), Lt = L(t), dLs = dL(s), dLt = dL(t);
      let X = 0, Y = 0, Xs = 0, Ys = 0, Xt = 0, Yt = 0;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const p = pts[i][j];
          X += p.x * Lt[i] * Ls[j];
          Y += p.y * Lt[i] * Ls[j];
          Xs += p.x * Lt[i] * dLs[j];
          Ys += p.y * Lt[i] * dLs[j];
          Xt += p.x * dLt[i] * Ls[j];
          Yt += p.y * dLt[i] * Ls[j];
        }
      }
      const f0 = X - x, f1 = Y - y;
      if (Math.abs(f0) < 0.01 && Math.abs(f1) < 0.01) break;
      const det = Xs * Yt - Xt * Ys;
      if (Math.abs(det) < 1e-12) break;
      s -= (Yt * f0 - Xt * f1) / det;
      t -= (Xs * f1 - Ys * f0) / det;
      s = Math.max(-0.5, Math.min(1.5, s));
      t = Math.max(-0.5, Math.min(1.5, t));
    }
    return { x: s * size, y: t * size };
  }

  return { warped: true, map, unmap };
}

function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
  const G = d * h - e * g, I = b * g - a * h, J = a * e - b * d;
  const det = a * A + b * D + c * G;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, I / det, J / det];
}
