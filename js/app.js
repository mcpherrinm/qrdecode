// UI: canvas rendering, grid manipulation, module forcing, output cross-highlighting.
'use strict';

const $ = id => document.getElementById(id);

const state = {
  imgCanvas: null,     // offscreen canvas holding the original image
  imgW: 0, imgH: 0,
  gray: null,          // Uint8Array luminance of the original image
  fileName: '',
  corners: null,       // [TL, TR, BR, BL] in image coords
  warpPts: null,       // 3x3 control points when warp mode is on (corners shared by ref)
  mapper: null,        // grid <-> image mapping (flat or warped)
  version: 2,
  ecOverride: null,    // null = auto
  maskOverride: null,  // null = auto
  thrOffset: 0,
  overrides: new Map(),// moduleIdx -> 0|1 (forced bits)
  view: { scale: 1, ox: 20, oy: 20 },
  sample: null,        // {means, bits, threshold}
  result: null,
  selHandle: -1,       // index into handleList()
  message: '',
};

let canvas, ctx, dpr = 1;
let charEls = [], cwEls = [], blockChipEls = [], blockHeadEls = [];
let hlEls = [];          // DOM elements currently carrying highlight classes
let hover = null;        // {bits, cw, block} sets of module indices (canvas layers)
let gToStream = new Map();
let dragActive = false;
let lastOutputRender = 0;

// ---------------------------------------------------------------- boot

window.addEventListener('DOMContentLoaded', () => {
  canvas = $('canvas');
  ctx = canvas.getContext('2d');
  setupCanvasSize();
  wireEvents();
  buildVersionSelect();
  renderSidebar();
  renderOutput();
  draw();
});

function setupCanvasSize() {
  const wrap = $('canvas-wrap');
  const ro = new ResizeObserver(() => {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
    draw();
  });
  ro.observe(wrap);
}

function buildVersionSelect() {
  const sel = $('sel-version');
  for (let v = 1; v <= 40; v++) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `${v} (${17 + 4 * v}×${17 + 4 * v})`;
    sel.appendChild(o);
  }
  sel.value = state.version;
}

// ---------------------------------------------------------------- image loading

async function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (e) {
    setMessage(`could not read image: ${e.message}`);
    return;
  }
  const off = document.createElement('canvas');
  off.width = bmp.width;
  off.height = bmp.height;
  off.getContext('2d').drawImage(bmp, 0, 0);
  state.imgCanvas = off;
  state.imgW = bmp.width;
  state.imgH = bmp.height;
  const idata = off.getContext('2d').getImageData(0, 0, bmp.width, bmp.height);
  state.gray = toGray(idata);
  state.fileName = file.name || 'pasted image';
  state.overrides.clear();
  state.result = null;
  $('file-name').textContent = `${state.fileName} · ${bmp.width}×${bmp.height}`;
  $('drop-hint').style.display = 'none';
  fitView();
  runDetect();
}

function fitView() {
  const cw = canvas.width / dpr, ch = canvas.height / dpr;
  const s = Math.min(cw / state.imgW, ch / state.imgH) * 0.92;
  state.view.scale = s;
  state.view.ox = (cw - state.imgW * s) / 2;
  state.view.oy = (ch - state.imgH * s) / 2;
}

function runDetect() {
  if (!state.imgCanvas) return;
  const maxDim = Math.max(state.imgW, state.imgH);
  const dscale = Math.min(1, 1200 / maxDim);
  let idata;
  if (dscale < 1) {
    const off = document.createElement('canvas');
    off.width = Math.round(state.imgW * dscale);
    off.height = Math.round(state.imgH * dscale);
    const octx = off.getContext('2d');
    octx.drawImage(state.imgCanvas, 0, 0, off.width, off.height);
    idata = octx.getImageData(0, 0, off.width, off.height);
  } else {
    idata = state.imgCanvas.getContext('2d').getImageData(0, 0, state.imgW, state.imgH);
  }
  const det = detectQR(idata);
  if (det) {
    state.corners = det.corners.map(p => ({ x: p.x / dscale, y: p.y / dscale }));
    if (state.warpPts) initWarpPts(); // rebuild control grid on the new corners
    state.version = det.version;
    $('sel-version').value = det.version;
    state.overrides.clear();
    setMessage(`detected: version ${det.version} (${17 + 4 * det.version}×${17 + 4 * det.version})`);
  } else {
    if (!state.corners) defaultGrid();
    setMessage('no finder patterns found — align the grid manually');
  }
  refresh(true);
}

function defaultGrid() {
  const side = Math.min(state.imgW, state.imgH) * 0.7;
  const cx = state.imgW / 2, cy = state.imgH / 2, r = side / 2;
  state.corners = [
    { x: cx - r, y: cy - r }, { x: cx + r, y: cy - r },
    { x: cx + r, y: cy + r }, { x: cx - r, y: cy + r },
  ];
  if (state.warpPts) initWarpPts();
}

// ---------------------------------------------------------------- pipeline

function gridSize() { return 17 + 4 * state.version; }

function updateH() {
  if (!state.corners) { state.mapper = null; return; }
  state.mapper = state.warpPts
    ? makeWarpMap(state.warpPts, gridSize())
    : makeFlatMap(state.corners, gridSize());
}

// ---- warp mode: 3x3 control points, corners shared by reference with state.corners.
const WARP_CORNER = { '0,0': 0, '0,2': 1, '2,2': 2, '2,0': 3 }; // [i,j] -> corners idx

// (Re)build the control grid from the current corners' flat homography — used both
// to enable warp mode and to flatten away accumulated curvature.
function initWarpPts() {
  const size = gridSize();
  const flat = makeFlatMap(state.corners, size);
  const pts = [];
  for (let i = 0; i < 3; i++) {
    const row = [];
    for (let j = 0; j < 3; j++) {
      const ci = WARP_CORNER[`${i},${j}`];
      row.push(ci !== undefined ? state.corners[ci] : flat.map(size * j / 2, size * i / 2));
    }
    pts.push(row);
  }
  state.warpPts = pts;
}

function setWarp(on) {
  if (on && !state.warpPts) {
    initWarpPts();
  } else if (!on && state.warpPts) {
    state.warpPts = null;
    state.selHandle = -1;
  } else {
    return;
  }
  refresh(true);
}

// Draggable handles in a stable order: flat = 4 corners; warp = all 9 control points.
function handleList() {
  if (!state.corners) return [];
  const labels = ['TL', 'TR', 'BR', 'BL'];
  if (!state.warpPts) {
    return state.corners.map((pt, i) => ({ pt, label: labels[i], corner: true }));
  }
  const out = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const ci = WARP_CORNER[`${i},${j}`];
      out.push({ pt: state.warpPts[i][j], label: ci !== undefined ? labels[ci] : '', corner: ci !== undefined });
    }
  }
  return out;
}

function resample() {
  if (!state.gray || !state.corners) { state.sample = null; return; }
  updateH();
  const size = gridSize();
  const map = state.mapper.map;
  const w = state.imgW, h = state.imgH, gray = state.gray;
  const means = new Float32Array(size * size);
  const off = 0.17;
  const offsets = [[0, 0], [-off, -off], [off, -off], [-off, off], [off, off]];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let sum = 0;
      for (const [dx, dy] of offsets) {
        const p = map(c + 0.5 + dx, r + 0.5 + dy);
        const x = Math.min(w - 1, Math.max(0, Math.round(p.x)));
        const y = Math.min(h - 1, Math.max(0, Math.round(p.y)));
        sum += gray[y * w + x];
      }
      means[r * size + c] = sum / offsets.length;
    }
  }
  const threshold = otsu(means) + state.thrOffset;
  const bits = new Uint8Array(size * size);
  for (let i = 0; i < bits.length; i++) bits[i] = means[i] <= threshold ? 1 : 0;
  state.sample = { means, bits, threshold };
}

function getEffectiveBit(r, c) {
  const size = gridSize();
  const i = r * size + c;
  const ovr = state.overrides.get(i);
  if (ovr !== undefined) return ovr;
  return state.sample ? state.sample.bits[i] : 0;
}

function decode() {
  if (!state.sample) { state.result = null; return; }
  state.result = decodeMatrix(getEffectiveBit, state.version, {
    ecOverride: state.ecOverride,
    maskOverride: state.maskOverride,
  });
  gToStream = new Map();
  state.result.stream.toGlobal.forEach((g, i) => gToStream.set(g, i));
}

// full = resample too (corners/threshold/version changed)
function refresh(full) {
  if (full) resample();
  decode();
  const now = performance.now();
  if (!dragActive || now - lastOutputRender > 150) {
    renderOutput();
    renderSidebar();
    lastOutputRender = now;
  }
  draw();
}

function setMessage(msg) {
  state.message = msg;
  $('message').textContent = msg;
}

// ---------------------------------------------------------------- canvas drawing

function imgToScreen(p) {
  return { x: p.x * state.view.scale + state.view.ox, y: p.y * state.view.scale + state.view.oy };
}
function screenToImg(x, y) {
  return { x: (x - state.view.ox) / state.view.scale, y: (y - state.view.oy) / state.view.scale };
}
function gridToScreen(u, v) {
  return imgToScreen(state.mapper.map(u, v));
}

function modulePx() {
  if (!state.corners) return 0;
  const size = gridSize();
  const d = Math.hypot(state.corners[1].x - state.corners[0].x,
                       state.corners[1].y - state.corners[0].y);
  return (d / size) * state.view.scale;
}

function draw() {
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = canvas.width / dpr, ch = canvas.height / dpr;
  ctx.clearRect(0, 0, cw, ch);
  if (!state.imgCanvas) return;

  const { scale, ox, oy } = state.view;
  ctx.imageSmoothingEnabled = scale < 2;
  ctx.drawImage(state.imgCanvas, ox, oy, state.imgW * scale, state.imgH * scale);

  if (!state.corners) return;
  updateH();
  const size = gridSize();
  const mpx = modulePx();
  const warped = !!state.warpPts;
  const sampleStep = Math.max(1, Math.round(size / 24));

  // Draw a grid-space line, sampled into segments when the surface is warped.
  const polyTo = (u0, v0, u1, v1, move) => {
    if (move) {
      const p0 = gridToScreen(u0, v0);
      ctx.moveTo(p0.x, p0.y);
    }
    const n = warped ? Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / sampleStep)) : 1;
    for (let k = 1; k <= n; k++) {
      const p = gridToScreen(u0 + (u1 - u0) * k / n, v0 + (v1 - v0) * k / n);
      ctx.lineTo(p.x, p.y);
    }
  };

  // Grid lines (straight under a flat projective map; sampled curves when warped).
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(128,128,128,0.5)';
  if (mpx > 3) {
    ctx.beginPath();
    for (let i = 1; i < size; i++) {
      polyTo(i, 0, i, size, true);
      polyTo(0, i, size, i, true);
    }
    ctx.stroke();
  }

  // Symbol outline + finder boxes.
  const outline = (u0, v0, u1, v1, width, color) => {
    ctx.beginPath();
    polyTo(u0, v0, u1, v0, true);
    polyTo(u1, v0, u1, v1, false);
    polyTo(u1, v1, u0, v1, false);
    polyTo(u0, v1, u0, v0, false);
    ctx.closePath();
    ctx.lineWidth = width + 2; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.stroke();
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
  };
  outline(0, 0, size, size, 1.5, '#000');
  outline(0, 0, 7, 7, 1, '#000');
  outline(size - 7, 0, size, 7, 1, '#000');
  outline(0, size - 7, 7, size, 1, '#000');

  // Highlight layers (under the dots).
  if (hover) {
    drawCells(hover.block, 'rgba(220,40,40,0.14)', null, 0);
    drawCells(hover.cw, 'rgba(220,40,40,0.28)', 'rgba(220,40,40,0.9)', 1);
    drawCells(hover.bits, 'rgba(220,40,40,0.4)', '#d92b2b', 2);
  }

  // Sample dots. Modules with a known expected value (finder, separator, timing,
  // alignment, dark module, and format/version under the assumed EC+mask) are
  // tinted red when they disagree — a live alignment-quality signal.
  if (mpx >= 2.8 && state.sample) {
    const layout = getLayout(state.version);
    const dyn = dynamicExpected();
    const r = Math.min(7, Math.max(1.4, mpx * 0.22));
    const black = new Path2D(), white = new Path2D();
    const badBlack = new Path2D(), badWhite = new Path2D();
    const forced = [];
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const i = row * size + col;
        const p = gridToScreen(col + 0.5, row + 0.5);
        const bit = getEffectiveBit(row, col);
        const exp = expectedBit(i, layout.expected, dyn);
        const path = exp >= 0 && exp !== bit ? (bit ? badBlack : badWhite) : (bit ? black : white);
        path.moveTo(p.x + r, p.y);
        path.arc(p.x, p.y, r, 0, Math.PI * 2);
        if (state.overrides.has(i)) forced.push(p);
      }
    }
    ctx.lineWidth = 1;
    ctx.fillStyle = '#000';
    ctx.fill(black);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke(black);
    ctx.fillStyle = '#fff';
    ctx.fill(white);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.stroke(white);
    ctx.fillStyle = '#a01515';
    ctx.fill(badBlack);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke(badBlack);
    ctx.fillStyle = '#ffc4c4';
    ctx.fill(badWhite);
    ctx.strokeStyle = '#d92b2b';
    ctx.stroke(badWhite);
    // Forced modules: red square marker.
    if (forced.length) {
      ctx.strokeStyle = '#d92b2b';
      ctx.lineWidth = 1.5;
      const s = r * 1.9;
      ctx.beginPath();
      for (const p of forced) ctx.rect(p.x - s, p.y - s, s * 2, s * 2);
      ctx.stroke();
    }
  }

  // Control handles: squares for corners, circles for warp mid-points.
  const handles = handleList();
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    const p = imgToScreen(h.pt);
    const sel = state.selHandle === i;
    ctx.fillStyle = sel ? '#000' : '#fff';
    ctx.strokeStyle = sel ? '#fff' : '#000';
    ctx.lineWidth = 2;
    if (h.corner) {
      ctx.fillRect(p.x - 6, p.y - 6, 12, 12);
      ctx.strokeRect(p.x - 6, p.y - 6, 12, 12);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - 6.5, p.y - 6.5, 13, 13);
      ctx.fillStyle = '#000';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(h.label, p.x + 9, p.y - 9);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// Expected values for format/version info modules, from the EC+mask actually in use.
function dynamicExpected() {
  const dyn = new Map();
  if (!state.result) return dyn;
  const size = gridSize();
  const fbits = encodeFormatBits(state.result.ec, state.result.mask);
  const { copy1, copy2 } = formatBitPositions(size);
  for (let i = 0; i < 15; i++) {
    const b = (fbits >> i) & 1;
    dyn.set(copy1[i][0] * size + copy1[i][1], b);
    dyn.set(copy2[i][0] * size + copy2[i][1], b);
  }
  if (state.version >= 7) {
    const vbits = encodeVersionBits(state.version);
    for (let i = 0; i < 18; i++) {
      const b = (vbits >> i) & 1;
      for (const [r, c] of versionBitPositions(size, i)) dyn.set(r * size + c, b);
    }
  }
  return dyn;
}

function expectedBit(i, layoutExpected, dyn) {
  const e = layoutExpected[i];
  if (e >= 0) return e;
  const d = dyn.get(i);
  return d === undefined ? -1 : d;
}

// How many known-value modules currently disagree with expectation.
function countMismatches() {
  if (!state.sample) return null;
  const layout = getLayout(state.version);
  const dyn = dynamicExpected();
  const size = layout.size;
  let bad = 0, total = 0;
  for (let i = 0; i < size * size; i++) {
    const e = expectedBit(i, layout.expected, dyn);
    if (e < 0) continue;
    total++;
    if (getEffectiveBit((i / size) | 0, i % size) !== e) bad++;
  }
  return { bad, total };
}

// Fill/stroke the projected quads of a set of module indices.
function drawCells(modSet, fill, stroke, lw) {
  if (!modSet || modSet.size === 0) return;
  const size = gridSize();
  ctx.beginPath();
  for (const i of modSet) {
    const r = (i / size) | 0, c = i % size;
    const p0 = gridToScreen(c, r), p1 = gridToScreen(c + 1, r),
          p2 = gridToScreen(c + 1, r + 1), p3 = gridToScreen(c, r + 1);
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
  }
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

// ---------------------------------------------------------------- interaction

let drag = null;

function wireEvents() {
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', () => { if (!drag) setHover(null); updateStatus(null); });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);

  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => loadImageFile(e.target.files[0]));
  $('btn-detect').addEventListener('click', runDetect);
  $('btn-reset-grid').addEventListener('click', () => {
    if (!state.imgCanvas) return;
    defaultGrid();
    state.overrides.clear();
    refresh(true);
  });
  $('btn-clear-ovr').addEventListener('click', () => {
    state.overrides.clear();
    refresh(false);
  });
  $('sel-version').addEventListener('change', e => {
    state.version = +e.target.value;
    state.overrides.clear();
    refresh(true);
  });
  $('sel-ec').addEventListener('change', e => {
    state.ecOverride = e.target.value === 'auto' ? null : e.target.value;
    refresh(false);
  });
  $('sel-mask').addEventListener('change', e => {
    state.maskOverride = e.target.value === 'auto' ? null : +e.target.value;
    refresh(false);
  });
  $('chk-warp').addEventListener('change', e => setWarp(e.target.checked));
  $('btn-flatten').addEventListener('click', () => {
    if (state.warpPts) {
      initWarpPts();
      refresh(true);
    }
  });
  $('rng-threshold').addEventListener('input', e => {
    state.thrOffset = +e.target.value;
    $('thr-label').textContent = (state.thrOffset >= 0 ? '+' : '') + state.thrOffset;
    refresh(true);
  });

  // Drag & drop + paste.
  const wrap = $('canvas-wrap');
  wrap.addEventListener('dragover', e => e.preventDefault());
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files.length) loadImageFile(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', e => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        loadImageFile(item.getAsFile());
        break;
      }
    }
  });

  $('output').addEventListener('mouseover', onOutputHover);
  $('output').addEventListener('mouseout', () => setHover(null));
  $('sidebar').addEventListener('mouseover', onOutputHover);
  $('sidebar').addEventListener('mouseout', () => setHover(null));
}

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function hitHandle(sx, sy) {
  const handles = handleList();
  for (let i = 0; i < handles.length; i++) {
    const p = imgToScreen(handles[i].pt);
    if (Math.abs(p.x - sx) <= 10 && Math.abs(p.y - sy) <= 10) return i;
  }
  return -1;
}

function hitModule(sx, sy) {
  if (!state.mapper) return null;
  const ip = screenToImg(sx, sy);
  const g = state.mapper.unmap(ip.x, ip.y);
  const size = gridSize();
  const c = Math.floor(g.x), r = Math.floor(g.y);
  if (r < 0 || r >= size || c < 0 || c >= size) return null;
  return { r, c, i: r * size + c };
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const p = canvasPos(e);
  canvas.setPointerCapture(e.pointerId);
  const hi = hitHandle(p.x, p.y);
  if (hi >= 0) {
    state.selHandle = hi;
    drag = { mode: 'handle', idx: hi, start: p, moved: false };
    dragActive = true;
  } else {
    drag = { mode: 'maybe', start: p, moved: false, view: { ...state.view } };
  }
  draw();
}

function onPointerMove(e) {
  const p = canvasPos(e);
  if (drag) {
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    if (drag.mode === 'handle' && drag.moved) {
      const h = handleList()[drag.idx];
      if (h) Object.assign(h.pt, screenToImg(p.x, p.y));
      refresh(true);
    } else if (drag.moved) {
      drag.mode = 'pan';
      state.view.ox = drag.view.ox + dx;
      state.view.oy = drag.view.oy + dy;
      draw();
    }
    return;
  }
  // Hover: status + cross-highlight from canvas to output.
  const m = hitModule(p.x, p.y);
  updateStatus(m);
  if (m && state.result) {
    const g = state.result.moduleToCw[m.i];
    if (g >= 0) { setHoverFromCw(g, m.i); return; }
  }
  setHover(null);
}

function onPointerUp(e) {
  const p = canvasPos(e);
  const wasDrag = drag;
  const wasActive = dragActive;
  drag = null;
  dragActive = false;
  if (!wasDrag) return;
  if (wasDrag.mode === 'maybe' && !wasDrag.moved) {
    const m = hitModule(p.x, p.y);
    if (m) {
      cycleOverride(m.i);
      refresh(false);
      return;
    }
    state.selHandle = -1;
    draw();
  } else if (wasActive) {
    refresh(true); // final full render after a corner drag
  }
}

function onContextMenu(e) {
  e.preventDefault();
  const p = canvasPos(e);
  const m = hitModule(p.x, p.y);
  if (m && state.overrides.has(m.i)) {
    state.overrides.delete(m.i);
    refresh(false);
  }
}

// auto -> force dark -> force light -> auto
function cycleOverride(i) {
  const cur = state.overrides.get(i);
  if (cur === undefined) state.overrides.set(i, 1);
  else if (cur === 1) state.overrides.set(i, 0);
  else state.overrides.delete(i);
}

function onWheel(e) {
  if (!state.imgCanvas) return;
  e.preventDefault();
  const p = canvasPos(e);
  const factor = Math.pow(1.0015, -e.deltaY);
  const ns = Math.min(200, Math.max(0.02, state.view.scale * factor));
  const k = ns / state.view.scale;
  state.view.ox = p.x - (p.x - state.view.ox) * k;
  state.view.oy = p.y - (p.y - state.view.oy) * k;
  state.view.scale = ns;
  draw();
}

function onKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') {
    state.selHandle = -1;
    setHover(null);
    draw();
    return;
  }
  const h = handleList()[state.selHandle];
  if (state.selHandle < 0 || !h) return;
  const px = e.shiftKey ? 0.1 : 1; // in image pixels
  const c = h.pt;
  let moved = true;
  switch (e.key) {
    case 'ArrowLeft': c.x -= px; break;
    case 'ArrowRight': c.x += px; break;
    case 'ArrowUp': c.y -= px; break;
    case 'ArrowDown': c.y += px; break;
    default: moved = false;
  }
  if (moved) {
    e.preventDefault();
    refresh(true);
  }
}

function updateStatus(m) {
  const parts = [];
  if (state.imgCanvas) parts.push(`${state.imgW}×${state.imgH}px`);
  if (state.sample) parts.push(`thr ${state.sample.threshold.toFixed(0)}`);
  if (m && state.sample) {
    const i = m.i;
    const forced = state.overrides.get(i);
    const bit = getEffectiveBit(m.r, m.c);
    parts.push(`module (${m.r},${m.c}) lum ${state.sample.means[i].toFixed(0)} → ${bit ? '■' : '□'}${forced !== undefined ? ' forced' : ''}`);
    const exp = expectedBit(i, getLayout(state.version).expected, dynamicExpected());
    if (exp >= 0 && exp !== bit) parts.push(`expected ${exp ? '■' : '□'}`);
    if (state.result) {
      const g = state.result.moduleToCw[i];
      if (g >= 0) {
        const cw = state.result.cw[g];
        parts.push(`cw #${g} ${cw.isEC ? 'EC' : 'data'} B${cw.block + 1}`);
      } else {
        parts.push(getLayout(state.version).isF[i] ? 'function pattern' : 'remainder');
      }
    }
  }
  $('statusbar-left').textContent = parts.join(' · ');
}

// ---------------------------------------------------------------- highlighting

function clearDomHighlight() {
  for (const el of hlEls) el.classList.remove('hl', 'hl-cw', 'hl-blk');
  hlEls = [];
}

function setHover(obj) {
  if (!obj && !hover && hlEls.length === 0) return;
  hover = obj ? { bits: obj.bits, cw: obj.cw, block: obj.block } : null;
  clearDomHighlight();
  if (obj) {
    for (const g of obj.cwIds || []) {
      const el = cwEls[g];
      if (el) { el.classList.add('hl'); hlEls.push(el); }
    }
    for (const ci of obj.charIds || []) {
      const el = charEls[ci];
      if (el) { el.classList.add('hl'); hlEls.push(el); }
    }
    for (const b of obj.blockIds || []) {
      if (blockChipEls[b]) { blockChipEls[b].classList.add('hl-blk'); hlEls.push(blockChipEls[b]); }
      if (blockHeadEls[b]) { blockHeadEls[b].classList.add('hl-blk'); hlEls.push(blockHeadEls[b]); }
    }
  }
  draw();
}

function blockModuleSet(b) {
  const res = state.result;
  const set = new Set();
  for (const g of res.blocks[b].globals) {
    for (const m of res.cw[g].modules) set.add(m);
  }
  return set;
}

function charIdsForBytes(byteSet) {
  const ids = [];
  const chars = state.result.parsed.chars;
  for (let ci = 0; ci < chars.length; ci++) {
    const c = chars[ci];
    for (let k = c.start >> 3; k <= (c.end - 1) >> 3; k++) {
      if (byteSet.has(k)) { ids.push(ci); break; }
    }
  }
  return ids;
}

function setHoverFromCw(g, strongModule) {
  const res = state.result;
  const cw = res.cw[g];
  const cwSet = new Set(cw.modules);
  const bits = new Set();
  if (strongModule != null) bits.add(strongModule);
  const charIds = [];
  if (!cw.isEC && gToStream.has(g)) {
    charIds.push(...charIdsForBytes(new Set([gToStream.get(g)])));
  }
  setHover({
    bits, cw: cwSet, block: blockModuleSet(cw.block),
    cwIds: [g], charIds, blockIds: [cw.block],
  });
}

function setHoverFromChar(ci) {
  const res = state.result;
  const c = res.parsed.chars[ci];
  const bitMods = new Set(modulesForBitRange(res, c.start, c.end));
  const cwIds = codewordsForBitRange(res, c.start, c.end);
  const cwSet = new Set();
  const blockIds = new Set();
  for (const g of cwIds) {
    for (const m of res.cw[g].modules) cwSet.add(m);
    blockIds.add(res.cw[g].block);
  }
  const blockSet = new Set();
  for (const b of blockIds) for (const m of blockModuleSet(b)) blockSet.add(m);
  setHover({
    bits: bitMods, cw: cwSet, block: blockSet,
    cwIds, charIds: [ci], blockIds: [...blockIds],
  });
}

function setHoverFromBlock(b) {
  const res = state.result;
  if (!res || !res.blocks[b]) return;
  const byteSet = new Set();
  res.stream.block.forEach((bb, k) => { if (bb === b) byteSet.add(k); });
  setHover({
    bits: new Set(), cw: new Set(), block: blockModuleSet(b),
    cwIds: res.blocks[b].globals, charIds: charIdsForBytes(byteSet), blockIds: [b],
  });
}

function setHoverFromSegment(si) {
  const res = state.result;
  const seg = res.parsed.segments[si];
  if (!seg) return;
  const bitMods = new Set(modulesForBitRange(res, seg.start, seg.end));
  const cwIds = codewordsForBitRange(res, seg.start, seg.end);
  const charIds = [];
  res.parsed.chars.forEach((c, ci) => { if (c.seg === si) charIds.push(ci); });
  const blockIds = new Set(cwIds.map(g => res.cw[g].block));
  setHover({ bits: bitMods, cw: new Set(), block: new Set(), cwIds, charIds, blockIds: [...blockIds] });
}

function onOutputHover(e) {
  if (!state.result) return;
  const t = e.target.closest('[data-g],[data-ci],[data-block],[data-seg]');
  if (!t) { setHover(null); return; }
  if (t.dataset.g !== undefined) setHoverFromCw(+t.dataset.g, null);
  else if (t.dataset.ci !== undefined) setHoverFromChar(+t.dataset.ci);
  else if (t.dataset.block !== undefined) setHoverFromBlock(+t.dataset.block);
  else if (t.dataset.seg !== undefined) setHoverFromSegment(+t.dataset.seg);
}

// ---------------------------------------------------------------- output rendering

function displayChar(ch) {
  const code = ch.codePointAt(0);
  if (code < 32) return String.fromCodePoint(0x2400 + code);
  if (code === 127) return '␡';
  return ch;
}

function renderOutput() {
  const res = state.result;
  charEls = []; cwEls = []; blockHeadEls = [];
  const textOut = $('text-out');
  const segList = $('seg-list');
  const cwOut = $('cw-out');
  const status = $('decode-status');
  textOut.textContent = '';
  segList.textContent = '';
  cwOut.textContent = '';

  if (!res) {
    status.textContent = state.imgCanvas ? 'no grid' : 'no image';
    status.className = 'dim';
    return;
  }

  const failed = res.blocks.filter(b => b.status === 'fail').length;
  const fixedTotal = res.blocks.reduce((s, b) => s + b.fixedCount, 0);
  let st, cls;
  if (failed === 0 && !res.parsed.error) {
    st = fixedTotal ? `OK — ${fixedTotal} codeword${fixedTotal > 1 ? 's' : ''} corrected` : 'OK';
    cls = 'ok';
  } else {
    const bits = [];
    if (failed) bits.push(`${failed}/${res.blocks.length} blocks failed`);
    if (res.parsed.error) bits.push(`parse stopped: ${res.parsed.error}`);
    st = `PARTIAL — ${bits.join(' · ')}`;
    cls = 'err';
  }
  status.textContent = st;
  status.className = cls;

  // Decoded text.
  const chars = res.parsed.chars;
  if (chars.length === 0) {
    const em = document.createElement('span');
    em.className = 'dim';
    em.textContent = res.parsed.error ? '(nothing decoded)' : '(empty)';
    textOut.appendChild(em);
  }
  chars.forEach((c, ci) => {
    const sp = document.createElement('span');
    sp.className = 'ch' + (c.suspect ? ' suspect' : '');
    sp.textContent = displayChar(c.ch);
    sp.dataset.ci = ci;
    sp.title = `bits ${c.start}–${c.end - 1}`;
    textOut.appendChild(sp);
    charEls[ci] = sp;
  });

  // Segments.
  res.parsed.segments.forEach((s, si) => {
    const sp = document.createElement('span');
    sp.className = 'seg';
    sp.dataset.seg = si;
    let label = s.mode;
    if (s.count) label += `×${s.count}`;
    if (s.mode === 'ECI') label += ` ${s.value}`;
    sp.textContent = label;
    segList.appendChild(sp);
  });
  if (res.parsed.error) {
    const sp = document.createElement('span');
    sp.className = 'seg err';
    sp.textContent = '✕ ' + res.parsed.error;
    segList.appendChild(sp);
  }

  // Codewords grouped by block.
  for (const blk of res.blocks) {
    const row = document.createElement('div');
    row.className = 'cwblock' + (blk.status === 'fail' ? ' failed' : '');
    const head = document.createElement('span');
    head.className = 'bhead';
    head.dataset.block = blk.index;
    head.textContent = `B${blk.index + 1} ` +
      (blk.status === 'fail' ? '✕' : blk.status === 'fixed' ? `+${blk.fixedCount}` : '✓');
    row.appendChild(head);
    blockHeadEls[blk.index] = head;
    for (const g of blk.globals) {
      const cw = res.cw[g];
      const sp = document.createElement('span');
      sp.className = 'cw' + (cw.isEC ? ' ec' : '') + (cw.fixed ? ' fixed' : '');
      sp.dataset.g = g;
      sp.textContent = cw.val.toString(16).padStart(2, '0');
      sp.title = `cw #${g} · block ${cw.block + 1} · ${cw.isEC ? 'EC' : 'data'}` +
        (cw.fixed ? ` · corrected ${cw.raw.toString(16).padStart(2, '0')}→${cw.val.toString(16).padStart(2, '0')}` : '');
      row.appendChild(sp);
      cwEls[g] = sp;
    }
    cwOut.appendChild(row);
  }
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const res = state.result;
  const fmtEl = $('format-info');
  if (res) {
    const f = res.format;
    let txt = `read: EC=${f.ec} mask=${f.mask} (dist ${f.distance})`;
    if (res.formatOverridden) txt += ` → using EC=${res.ec} mask=${res.mask}`;
    fmtEl.textContent = txt;
    fmtEl.className = 'mono-line' + (f.distance > 6 && !res.formatOverridden ? ' err' : '');
    const vi = $('version-info');
    if (res.versionInfo) {
      const mism = res.versionInfo.version !== state.version;
      vi.textContent = `version info bits: V${res.versionInfo.version} (dist ${res.versionInfo.distance})` +
        (mism ? ' ≠ grid' : '');
      vi.className = 'mono-line' + (mism && res.versionInfo.distance <= 6 ? ' err' : '');
    } else {
      vi.textContent = '';
    }
  } else {
    fmtEl.textContent = '—';
    fmtEl.className = 'mono-line dim';
    $('version-info').textContent = '';
  }

  $('override-info').textContent = `${state.overrides.size} forced module${state.overrides.size === 1 ? '' : 's'}`;

  // Known-pattern agreement (alignment quality signal).
  const mm = countMismatches();
  const fnEl = $('fn-info');
  if (mm) {
    fnEl.textContent = mm.bad === 0
      ? `known patterns: all ${mm.total} match`
      : `known patterns: ${mm.bad}/${mm.total} mismatched`;
    fnEl.className = 'mono-line' + (mm.bad > 0 ? ' err' : ' dim');
  } else {
    fnEl.textContent = '';
    fnEl.className = 'mono-line dim';
  }

  // Block chips.
  const bl = $('block-list');
  bl.textContent = '';
  blockChipEls = [];
  if (res) {
    for (const blk of res.blocks) {
      const chip = document.createElement('span');
      chip.className = 'chip ' + blk.status;
      chip.dataset.block = blk.index;
      chip.textContent = `B${blk.index + 1}${blk.status === 'fail' ? '✕' : blk.status === 'fixed' ? `+${blk.fixedCount}` : '✓'}`;
      chip.title = `block ${blk.index + 1}: ${blk.dataGlobal.length} data + ${blk.ecGlobal.length} EC codewords — ` +
        (blk.status === 'fail' ? 'uncorrectable' : blk.status === 'fixed' ? `${blk.fixedCount} corrected` : 'clean');
      bl.appendChild(chip);
      blockChipEls[blk.index] = chip;
    }
  }
}
