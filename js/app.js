// UI: canvas rendering, grid manipulation, module forcing, output cross-highlighting.
'use strict';

const $ = id => document.getElementById(id);

const state = {
  imgCanvas: null,     // offscreen canvas holding the original image
  imgBlob: null,       // original image file bytes (for save-state and persistence)
  imgW: 0, imgH: 0,
  gray: null,          // Uint8Array luminance of the original image
  fileName: '',
  corners: null,       // [TL, TR, BR, BL] in image coords
  warpPts: null,       // 3x3 warp control points (corner objects shared with state.corners)
  mapper: null,        // grid <-> image mapping (flat or warped)
  version: 2,
  ecOverride: null,    // null = auto
  maskOverride: null,  // null = auto
  thrOffset: 0,
  invert: false,       // inverted-colour (light-on-dark) symbol: flip the sampled bits
  quietZone: 0,        // modules of quiet zone to show around the symbol (0-4), display-only
  overrides: new Map(),// moduleIdx -> 0|1 (forced bit) | 2 (ignored: RS erasure)
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
  syncControls();
  renderSidebar();
  renderOutput();
  draw();
  restoreSession();
});

// Push app state into the sidebar controls. Guards against the browser restoring
// stale form values across a reload, and re-syncs after a session restore.
function syncControls() {
  $('sel-version').value = state.version;
  $('sel-ec').value = state.ecOverride == null ? 'auto' : state.ecOverride;
  $('sel-mask').value = state.maskOverride == null ? 'auto' : String(state.maskOverride);
  $('rng-threshold').value = state.thrOffset;
  $('thr-label').textContent = (state.thrOffset >= 0 ? '+' : '') + state.thrOffset;
  $('sel-quiet').value = String(state.quietZone);
  $('chk-invert').checked = state.invert;
}

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

// One entry point for every way a file arrives (open button, drop, paste):
// .qrdecode state files — recognized by extension, or by magic when the name
// doesn't say — restore a whole session; anything else is treated as an image.
async function loadImageFile(file) {
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  if (/\.qrdecode$/i.test(file.name || '') ||
      (!isImage && stateFileSniff(new Uint8Array(await file.slice(0, 4).arrayBuffer())))) {
    return loadStateFile(file);
  }
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (e) {
    const name = file.name || 'file';
    setMessage(/\.hei[cf]$/i.test(name) || /hei[cf]/.test(file.type)
      ? `could not read ${name} — this browser can't decode HEIC; convert it to JPEG or PNG first`
      : `could not read ${name} — not a supported image`);
    return;
  }
  applyImage(bmp, file.name || 'pasted image', file);
  persistImage(file);
  fitView();
  runDetect();
  clearHistory(); // undo history belongs to the previous image
}

// Save the whole session — decoder state + original image bytes — as one
// .qrdecode file the load-state button (or a drop) can restore anywhere.
async function saveStateFile() {
  if (!state.imgCanvas || !state.corners) {
    setMessage('nothing to save yet — load an image first');
    return;
  }
  if (!state.warpPts) initWarpPts();
  let blob = state.imgBlob;
  if (!blob) blob = await new Promise(res => state.imgCanvas.toBlob(res, 'image/png'));
  const bytes = stateFileEncode({
    version: state.version,
    imgW: state.imgW, imgH: state.imgH,
    ecOverride: state.ecOverride,
    maskOverride: state.maskOverride,
    thrOffset: state.thrOffset,
    invert: state.invert,
    quietZone: state.quietZone,
    warpPts: state.warpPts,
    overrides: state.overrides,
  }, new Uint8Array(await blob.arrayBuffer()), state.fileName, blob.type || 'image/png');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = (state.fileName.replace(/\.[a-z0-9]+$/i, '') || 'session') + '.qrdecode';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setMessage(`saved ${a.download} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

async function loadStateFile(file) {
  let dec;
  try {
    dec = stateFileDecode(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    setMessage(`could not read state file: ${e.message}`);
    return;
  }
  const blob = new Blob([dec.image.bytes], { type: dec.image.mime || 'image/png' });
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    setMessage(`state file's image is unreadable: ${e.message}`);
    return;
  }
  applyImage(bmp, dec.image.name || file.name, blob);
  persistImage(blob);
  fitView();
  applySavedState(dec);
  refresh(true);
  clearHistory();
  if (bmp.width !== dec.imgW || bmp.height !== dec.imgH) {
    setMessage(`loaded ${file.name}, but its grid was saved for a ${dec.imgW}×${dec.imgH} image`);
  } else {
    setMessage(`loaded ${file.name}`);
  }
}

function applyImage(bmp, name, blob) {
  state.imgBlob = blob || null;
  const w = bmp.width, h = bmp.height;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  off.getContext('2d').drawImage(bmp, 0, 0);
  state.imgCanvas = off;
  state.imgW = w;
  state.imgH = h;
  const idata = off.getContext('2d').getImageData(0, 0, w, h);
  state.gray = toGray(idata);
  state.fileName = name;
  state.overrides.clear();
  state.result = null;
  $('file-name').textContent = `${state.fileName} · ${w}×${h}`;
  $('drop-hint').style.display = 'none';
}

function fitView() {
  const cw = canvas.width / dpr, ch = canvas.height / dpr;
  const s = Math.min(cw / state.imgW, ch / state.imgH) * 0.92;
  state.view.scale = s;
  state.view.ox = (cw - state.imgW * s) / 2;
  state.view.oy = (ch - state.imgH * s) / 2;
}

// Zoom/pan the view so the symbol fills the viewport, with a margin a bit
// wider than the 4-module quiet zone (whether or not it's displayed). The
// extended boundary is sampled through the mapper so warped grids fit too.
function fitGrid() {
  if (!state.corners) return;
  updateH();
  const size = gridSize();
  const lo = -5, hi = size + 5;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const n = 24;
  for (let k = 0; k <= n; k++) {
    const t = lo + (hi - lo) * k / n;
    for (const p of [state.mapper.map(t, lo), state.mapper.map(t, hi),
                     state.mapper.map(lo, t), state.mapper.map(hi, t)]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  const cw = canvas.width / dpr, ch = canvas.height / dpr;
  const s = Math.min(cw / (maxX - minX), ch / (maxY - minY));
  if (!isFinite(s) || s <= 0) return;
  state.view.scale = s;
  state.view.ox = (cw - (maxX - minX) * s) / 2 - minX * s;
  state.view.oy = (ch - (maxY - minY) * s) / 2 - minY * s;
  draw();
  scheduleSave();
}

function runDetect() {
  if (!state.imgCanvas) return;
  if (state.corners) pushHistory(); // re-detect over an existing grid is undoable
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
    initWarpPts(); // rebuild control grid on the new corners
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
  initWarpPts();
}

// ---------------------------------------------------------------- persistence
// The in-progress investigation (image + grid + forced bits + settings) survives
// reloads. IndexedDB rather than localStorage: photos easily exceed the ~5MB
// localStorage quota, and IDB stores the image Blob natively.

const SAVE_VERSION = 1;

let idbPromise = null;
function idbOpen() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no indexedDB'));
  if (!idbPromise) {
    idbPromise = new Promise((res, rej) => {
      const r = indexedDB.open('qrdecode', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return idbPromise;
}

async function idbPut(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

function persistImage(fileBlob) {
  idbPut('image', { blob: fileBlob, name: state.fileName })
    .catch(e => console.warn('qrdecode: could not persist image', e));
}

let saveTimer = 0;
function scheduleSave() {
  if (!state.imgCanvas || !state.corners) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}

function saveState() {
  if (!state.corners) return;
  if (!state.warpPts) initWarpPts();
  idbPut('state', {
    v: SAVE_VERSION,
    fileName: state.fileName,
    version: state.version,
    warpPts: state.warpPts.map(row => row.map(p => ({ x: p.x, y: p.y }))),
    ecOverride: state.ecOverride,
    maskOverride: state.maskOverride,
    thrOffset: state.thrOffset,
    invert: state.invert,
    quietZone: state.quietZone,
    overrides: [...state.overrides],
    view: { ...state.view },
  }).catch(() => {});
}

// Re-apply a saved state snapshot (grid, forced bits, settings, view).
function applySavedState(saved) {
  state.version = saved.version;
  state.warpPts = saved.warpPts.map(row => row.map(p => ({ x: p.x, y: p.y })));
  state.corners = [
    state.warpPts[0][0], state.warpPts[0][2],
    state.warpPts[2][2], state.warpPts[2][0],
  ];
  state.ecOverride = saved.ecOverride;
  state.maskOverride = saved.maskOverride;
  state.thrOffset = saved.thrOffset;
  state.invert = !!saved.invert;
  state.quietZone = saved.quietZone || 0;
  state.overrides = new Map(saved.overrides);
  // Older sessions/state files could force spec-fixed modules; drop those.
  for (const i of [...state.overrides.keys()]) {
    if (isLockedModule(i)) state.overrides.delete(i);
  }
  if (saved.view) state.view = { ...saved.view };
  state.selHandle = -1;
  syncControls();
}

// On boot: restore image + state if present. Skips auto-detection so the
// restored grid alignment is untouched.
async function restoreSession() {
  let img, saved;
  try {
    [img, saved] = await Promise.all([idbGet('image'), idbGet('state')]);
  } catch (e) {
    return false; // no storage available
  }
  if (!img || !img.blob || !saved || saved.v !== SAVE_VERSION) return false;
  try {
    const bmp = await createImageBitmap(img.blob);
    applyImage(bmp, img.name || saved.fileName || 'restored image', img.blob);
    applySavedState(saved);
    setMessage('restored previous session');
    refresh(true);
    return true;
  } catch (e) {
    console.warn('qrdecode: session restore failed', e);
    return false;
  }
}

// ---------------------------------------------------------------- undo/redo
// Session-only history (not persisted) of everything that affects the decode:
// grid geometry, version, EC/mask/threshold, and module overrides. View pan/zoom
// is deliberately excluded. A snapshot is pushed BEFORE each mutation; rapid
// repeats of the same action (slider drags, arrow-key nudges) coalesce by tag.

const undoStack = [], redoStack = [];
const HISTORY_MAX = 100;
let lastHistTag = null, lastHistTime = 0;

function historySnapshot() {
  return {
    version: state.version,
    warpPts: state.warpPts ? state.warpPts.map(row => row.map(p => ({ x: p.x, y: p.y }))) : null,
    ecOverride: state.ecOverride,
    maskOverride: state.maskOverride,
    thrOffset: state.thrOffset,
    invert: state.invert,
    overrides: [...state.overrides],
  };
}

function applyHistorySnapshot(s) {
  state.version = s.version;
  if (s.warpPts) {
    state.warpPts = s.warpPts.map(row => row.map(p => ({ x: p.x, y: p.y })));
    state.corners = [
      state.warpPts[0][0], state.warpPts[0][2],
      state.warpPts[2][2], state.warpPts[2][0],
    ];
  }
  state.ecOverride = s.ecOverride;
  state.maskOverride = s.maskOverride;
  state.thrOffset = s.thrOffset;
  state.invert = !!s.invert;
  state.overrides = new Map(s.overrides);
  state.selHandle = -1;
  syncControls();
  hideDotMenu();
  refresh(true);
}

function pushHistory(tag) {
  const now = Date.now();
  if (tag && tag === lastHistTag && now - lastHistTime < 800) {
    lastHistTime = now;
    return; // coalesce a burst of the same action into one undo step
  }
  undoStack.push(historySnapshot());
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  lastHistTag = tag || null;
  lastHistTime = now;
  updateUndoButtons();
}

function doUndo() {
  if (!undoStack.length) return;
  redoStack.push(historySnapshot());
  applyHistorySnapshot(undoStack.pop());
  lastHistTag = null;
  setMessage(`undo (${undoStack.length} left)`);
  updateUndoButtons();
}

function doRedo() {
  if (!redoStack.length) return;
  undoStack.push(historySnapshot());
  applyHistorySnapshot(redoStack.pop());
  lastHistTag = null;
  setMessage(`redo (${redoStack.length} left)`);
  updateUndoButtons();
}

function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  lastHistTag = null;
  updateUndoButtons();
}

function updateUndoButtons() {
  $('btn-undo').disabled = undoStack.length === 0;
  $('btn-redo').disabled = redoStack.length === 0;
}

// ---------------------------------------------------------------- pipeline

function gridSize() { return 17 + 4 * state.version; }

// Warp is always on: the mapper is the 3x3 control surface, initialized flat.
function updateH() {
  if (!state.corners) { state.mapper = null; return; }
  if (!state.warpPts) initWarpPts();
  state.mapper = makeWarpMap(state.warpPts, gridSize());
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

// Draggable handles in a stable order: all 9 control points.
function handleList() {
  if (!state.corners) return [];
  if (!state.warpPts) initWarpPts();
  const labels = ['top left', 'top right', 'bottom right', 'bottom left'];
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
  // Inverted (light-on-dark) symbols: a dark sample reads as a 0 module.
  const dark = state.invert ? 0 : 1;
  const bits = new Uint8Array(size * size);
  for (let i = 0; i < bits.length; i++) bits[i] = means[i] <= threshold ? dark : 1 - dark;

  // Quiet-zone ring around the symbol, display-only (never fed to the decoder).
  // Same threshold as the interior — otsu stays interior-only so a large white
  // border can't skew it.
  let quiet = null;
  const q = state.quietZone;
  if (q > 0) {
    quiet = [];
    for (let r = -q; r < size + q; r++) {
      for (let c = -q; c < size + q; c++) {
        if (r >= 0 && r < size && c >= 0 && c < size) continue;
        let sum = 0;
        for (const [dx, dy] of offsets) {
          const p = map(c + 0.5 + dx, r + 0.5 + dy);
          const x = Math.min(w - 1, Math.max(0, Math.round(p.x)));
          const y = Math.min(h - 1, Math.max(0, Math.round(p.y)));
          sum += gray[y * w + x];
        }
        quiet.push({ r, c, bit: sum / offsets.length <= threshold ? dark : 1 - dark });
      }
    }
  }
  state.sample = { means, bits, threshold, quiet };
}

function getEffectiveBit(r, c) {
  const size = gridSize();
  const i = r * size + c;
  const ovr = state.overrides.get(i);
  if (ovr === 0 || ovr === 1) return ovr;
  return state.sample ? state.sample.bits[i] : 0;
}

function isIgnoredModule(r, c) {
  return state.overrides.get(r * gridSize() + c) === 2;
}

// Spec-fixed modules (function patterns, format/version info) are read-only:
// the decoder never reads function patterns, and forcing any of them would
// only mask the alignment-quality signal.
function isLockedModule(i) {
  return !!getLayout(state.version).isF[i];
}

function decode() {
  if (!state.sample) { state.result = null; return; }
  state.result = decodeMatrix(getEffectiveBit, state.version, {
    ecOverride: state.ecOverride,
    maskOverride: state.maskOverride,
    isIgnored: isIgnoredModule,
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
  if (!state.sample) hideDotMenu();
  else if (menuModule != null) renderDotMenu();
  draw();
  scheduleSave();
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

  // Quiet-zone boundary: dashed, outside the symbol.
  const qz = state.quietZone;
  if (qz > 0) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    outline(-qz, -qz, size + qz, size + qz, 1, 'rgba(0,0,0,0.55)');
    ctx.restore();
  }

  // Highlight layers (under the dots). Green, so the trace reads apart from the
  // red error/forced markers.
  if (hover) {
    drawCells(hover.block, 'rgba(26,150,60,0.14)', null, 0);
    drawCells(hover.cw, 'rgba(26,150,60,0.28)', 'rgba(26,150,60,0.9)', 1);
    drawCells(hover.bits, 'rgba(26,150,60,0.4)', '#1a963c', 2);
  }

  // Sample dots. Modules with a known expected value (finder, separator, timing,
  // alignment, dark module, and format/version under the assumed EC+mask) are
  // tinted red when they disagree — a live alignment-quality signal.
  if (mpx >= 2.8 && state.sample) {
    const layout = getLayout(state.version);
    const dyn = dynamicExpected();
    const r = Math.min(7, Math.max(1.4, mpx * 0.22));
    // Known-value modules (and quiet zone) draw as slightly smaller squares,
    // laid out in grid space so they warp/rotate with the grid; data modules
    // stay round dots, so shape says spec-fixed vs data at a glance.
    const hKnown = (r * 0.75) / mpx; // half-side in grid units
    const sq = (path, col, row, h) => {
      const p0 = gridToScreen(col + 0.5 - h, row + 0.5 - h);
      const p1 = gridToScreen(col + 0.5 + h, row + 0.5 - h);
      const p2 = gridToScreen(col + 0.5 + h, row + 0.5 + h);
      const p3 = gridToScreen(col + 0.5 - h, row + 0.5 + h);
      path.moveTo(p0.x, p0.y);
      path.lineTo(p1.x, p1.y);
      path.lineTo(p2.x, p2.y);
      path.lineTo(p3.x, p3.y);
      path.closePath();
    };
    // Data dots are circles in grid space too: the local Jacobian (sampled
    // with two offset points) turns each into the screen ellipse a warped or
    // perspective grid implies. Closed-form 2x2 SVD gives axes + rotation.
    const hData = r / mpx;
    const ell = (path, col, row, p) => {
      const pu = gridToScreen(col + 0.5 + hData, row + 0.5);
      const pv = gridToScreen(col + 0.5, row + 0.5 + hData);
      const ma = pu.x - p.x, mc = pu.y - p.y; // image of grid +x
      const mb = pv.x - p.x, md = pv.y - p.y; // image of grid +y
      const E = (ma + md) / 2, F = (ma - md) / 2;
      const G = (mc + mb) / 2, H = (mc - mb) / 2;
      const Q = Math.hypot(E, H), R = Math.hypot(F, G);
      const rx = Q + R, ry = Math.abs(Q - R);
      const rot = (Math.atan2(H, E) + Math.atan2(G, F)) / 2;
      path.moveTo(p.x + rx * Math.cos(rot), p.y + rx * Math.sin(rot));
      path.ellipse(p.x, p.y, rx, ry, rot, 0, Math.PI * 2);
    };
    const black = new Path2D(), white = new Path2D();
    const badBlack = new Path2D(), badWhite = new Path2D();
    // Forced-module markers: grid-space squares around the dot — red when the
    // forced value overrides the sampled one, purple when it matches it.
    const hForce = (r * 1.9) / mpx;
    const forcedDiff = new Path2D(), forcedSame = new Path2D();
    const ignored = [];
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const i = row * size + col;
        const p = gridToScreen(col + 0.5, row + 0.5);
        const ovr = state.overrides.get(i);
        const bit = getEffectiveBit(row, col);
        const exp = expectedBit(i, layout.expected, dyn);
        // Ignored modules are known damage — no point tinting them as mismatches.
        const bad = ovr !== 2 && exp >= 0 && exp !== bit;
        const path = bad ? (bit ? badBlack : badWhite) : (bit ? black : white);
        if (exp >= 0) sq(path, col, row, hKnown);
        else ell(path, col, row, p);
        if (ovr === 2) ignored.push(p);
        else if (ovr !== undefined) {
          sq(ovr === state.sample.bits[i] ? forcedSame : forcedDiff, col, row, hForce);
        }
      }
    }
    // Forced-marker backdrops go under the dots.
    ctx.fillStyle = 'rgba(128,128,128,0.35)';
    ctx.fill(forcedDiff);
    ctx.fill(forcedSame);
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
    // Quiet-zone dots: the spec requires all white, so dark reads get the
    // mismatch tint — anything red out there means encroachment or misalignment.
    if (state.sample.quiet) {
      const qDark = new Path2D(), qLight = new Path2D();
      for (const m of state.sample.quiet) {
        sq(m.bit ? qDark : qLight, m.c, m.r, hKnown);
      }
      ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fill(qLight);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke(qLight);
      ctx.fillStyle = '#a01515';
      ctx.fill(qDark);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke(qDark);
    }
    // Forced-marker borders go over the dots.
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#d92b2b';
    ctx.stroke(forcedDiff);
    ctx.strokeStyle = '#822bd9';
    ctx.stroke(forcedSame);
    // Ignored modules: gray × marker (codeword becomes an RS erasure).
    if (ignored.length) {
      const s = r * 1.5;
      ctx.beginPath();
      for (const p of ignored) {
        ctx.moveTo(p.x - s, p.y - s); ctx.lineTo(p.x + s, p.y + s);
        ctx.moveTo(p.x + s, p.y - s); ctx.lineTo(p.x - s, p.y + s);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Marquee (shift-drag): dashed rectangle while marking an ignore area.
  if (state.marquee) {
    const mq = state.marquee;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.min(mq.x0, mq.x1), Math.min(mq.y0, mq.y1),
                   Math.abs(mq.x1 - mq.x0), Math.abs(mq.y1 - mq.y0));
    ctx.restore();
  }

  // Control handles: bright blue unfilled diamonds (corners drag perspective,
  // the rest bend the grid); unfilled so the module dot underneath stays visible.
  const HANDLE_BLUE = '#2979ff', HANDLE_BLUE_DARK = '#0d3fb8';
  const handles = handleList();
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    const p = imgToScreen(h.pt);
    const sel = state.selHandle === i;
    const blue = sel ? HANDLE_BLUE_DARK : HANDLE_BLUE;
    const s = 9;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - s);
    ctx.lineTo(p.x + s, p.y);
    ctx.lineTo(p.x, p.y + s);
    ctx.lineTo(p.x - s, p.y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = blue;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Rotate grabber: one circular arrow floating above the top edge center.
  const rp = rotHandlePosition();
  if (rp) {
    const end = 5.0; // arc end angle (rad); gap leaves room for the arrowhead
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, 6, 0.8, end);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = HANDLE_BLUE;
    ctx.lineWidth = 2;
    ctx.stroke();
    const ex = rp.x + 6 * Math.cos(end), ey = rp.y + 6 * Math.sin(end);
    const tx = -Math.sin(end), ty = Math.cos(end); // direction of travel at arc end
    const nx = Math.cos(end), ny = Math.sin(end);
    ctx.fillStyle = HANDLE_BLUE;
    ctx.beginPath();
    ctx.moveTo(ex + tx * 6, ey + ty * 6);
    ctx.lineTo(ex + nx * 3.2, ey + ny * 3.2);
    ctx.lineTo(ex - nx * 3.2, ey - ny * 3.2);
    ctx.closePath();
    ctx.fill();
  }

  // Move handle: four-direction arrow floating below the bottom edge center.
  const mp = moveHandlePosition();
  if (mp) {
    ctx.beginPath();
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const vx = -uy, vy = ux; // perpendicular, for the arrowhead
      const tip = { x: mp.x + ux * 8, y: mp.y + uy * 8 };
      ctx.moveTo(mp.x, mp.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.moveTo(tip.x - ux * 3.5 + vx * 2.8, tip.y - uy * 3.5 + vy * 2.8);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(tip.x - ux * 3.5 - vx * 2.8, tip.y - uy * 3.5 - vy * 2.8);
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = HANDLE_BLUE;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Scale handles: outward-pointing double arrows outside each corner.
  for (const p of scaleHandlePositions()) {
    const { x: ux, y: uy } = p.dir;       // outward unit vector
    const vx = -uy, vy = ux;              // perpendicular (for arrowheads)
    const a = { x: p.x - ux * 7, y: p.y - uy * 7 };
    const b = { x: p.x + ux * 7, y: p.y + uy * 7 };
    const head = (tip, dx, dy) => {
      ctx.moveTo(tip.x - dx * 4.5 + vx * 3.2, tip.y - dy * 4.5 + vy * 3.2);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(tip.x - dx * 4.5 - vx * 3.2, tip.y - dy * 4.5 - vy * 3.2);
    };
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    head(b, ux, uy);
    head(a, -ux, -uy);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = HANDLE_BLUE;
    ctx.lineWidth = 2;
    ctx.stroke();
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
    if (e < 0 || state.overrides.get(i) === 2) continue; // ignored = known damage
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

// Multi-touch pinch: pointers currently down on the canvas (id → canvas pos)
// and the pinch baselines. pinchMid === null means no pinch in progress.
const activePointers = new Map();
let pinchDist = 0;
let pinchMid = null;

function wireEvents() {
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', () => {
    if (!drag) setHover(null);
    updateStatus(null);
    hideHandleTip();
    hideDotMenu(); // the tooltip takes no clicks, so no grace period on leave
  });

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);

  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => loadImageFile(e.target.files[0]));
  $('btn-save-state').addEventListener('click', saveStateFile);
  $('btn-help').addEventListener('click', () => $('help-dialog').showModal());
  $('btn-help-close').addEventListener('click', () => $('help-dialog').close());
  // Click on the backdrop (the dialog element itself, outside .help-head/.help-body).
  $('help-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
  $('btn-detect').addEventListener('click', runDetect);
  $('btn-reset-grid').addEventListener('click', () => {
    if (!state.imgCanvas) return;
    pushHistory();
    defaultGrid();
    state.overrides.clear();
    refresh(true);
  });
  $('btn-undo').addEventListener('click', doUndo);
  $('btn-redo').addEventListener('click', doRedo);
  $('btn-clear-ovr').addEventListener('click', () => {
    if (state.overrides.size) pushHistory();
    state.overrides.clear();
    refresh(false);
  });
  $('sel-version').addEventListener('change', e => {
    pushHistory();
    state.version = +e.target.value;
    state.overrides.clear();
    refresh(true);
  });
  $('sel-ec').addEventListener('change', e => {
    pushHistory();
    state.ecOverride = e.target.value === 'auto' ? null : e.target.value;
    refresh(false);
  });
  $('sel-mask').addEventListener('change', e => {
    pushHistory();
    state.maskOverride = e.target.value === 'auto' ? null : +e.target.value;
    refresh(false);
  });
  $('rng-threshold').addEventListener('input', e => {
    pushHistory('thr');
    state.thrOffset = +e.target.value;
    $('thr-label').textContent = (state.thrOffset >= 0 ? '+' : '') + state.thrOffset;
    refresh(true);
  });
  // Display-only (doesn't affect the decode), so like pan/zoom it skips history.
  $('sel-quiet').addEventListener('change', e => {
    state.quietZone = +e.target.value;
    refresh(true);
  });
  $('chk-invert').addEventListener('change', e => {
    pushHistory();
    state.invert = e.target.checked;
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

  // Mobile: sidebar toggle
  $('btn-sidebar-toggle').addEventListener('click', () => {
    $('sidebar').classList.toggle('open');
  });

  // Mobile: maximize canvas button
  $('btn-fit').addEventListener('click', fitGrid);
  $('btn-maximize').addEventListener('click', () => {
    const wrap = $('canvas-wrap');
    const maximized = wrap.classList.toggle('maximized');
    $('btn-maximize').textContent = maximized ? '✕' : '⤢';
    // ResizeObserver in setupCanvasSize() will fire automatically.
  });

  // The 'open' class is only styled — and its toggle button only visible —
  // below the mobile breakpoint, so clear it when leaving (e.g. rotating a
  // phone to landscape) or it strands in effect-less state.
  const mobileMq = window.matchMedia('(max-width: 640px)');
  mobileMq.addEventListener('change', () => {
    if (!mobileMq.matches) $('sidebar').classList.remove('open');
  });
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

// ---- rotation: grabbers floating outside each corner, rotating the whole grid
// (corners + warp points) around the grid center.

function gridCenterImg() {
  const c = state.corners;
  return {
    x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
    y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
  };
}

// Every control point that rotation moves.
function rotatablePoints() {
  const pts = [...state.corners];
  if (state.warpPts) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (WARP_CORNER[`${i},${j}`] === undefined) pts.push(state.warpPts[i][j]);
      }
    }
  }
  return pts;
}

// Screen position of the single rotate grabber, floating above the top edge center.
function rotHandlePosition() {
  if (!state.corners) return null;
  if (!state.mapper) updateH();
  const size = gridSize();
  const mid = gridToScreen(size / 2, 0);
  const ctr = gridToScreen(size / 2, size / 2);
  const dx = mid.x - ctr.x, dy = mid.y - ctr.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: mid.x + dx / d * 26, y: mid.y + dy / d * 26 };
}

function hitRotHandle(sx, sy) {
  const p = rotHandlePosition();
  return !!p && Math.hypot(p.x - sx, p.y - sy) <= 10;
}

// Screen position of the move handle, floating below the bottom edge center
// (opposite the rotate grabber).
function moveHandlePosition() {
  if (!state.corners) return null;
  if (!state.mapper) updateH();
  const size = gridSize();
  const mid = gridToScreen(size / 2, size);
  const ctr = gridToScreen(size / 2, size / 2);
  const dx = mid.x - ctr.x, dy = mid.y - ctr.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: mid.x + dx / d * 26, y: mid.y + dy / d * 26 };
}

function hitMoveHandle(sx, sy) {
  const p = moveHandlePosition();
  return !!p && Math.hypot(p.x - sx, p.y - sy) <= 10;
}

// Screen positions of the four scale handles, pushed diagonally out from corners.
function scaleHandlePositions() {
  if (!state.corners) return [];
  const cs = state.corners.map(imgToScreen);
  const cx = (cs[0].x + cs[1].x + cs[2].x + cs[3].x) / 4;
  const cy = (cs[0].y + cs[1].y + cs[2].y + cs[3].y) / 4;
  return cs.map(p => {
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx / d * 26, y: p.y + dy / d * 26, dir: { x: dx / d, y: dy / d } };
  });
}

function hitScaleHandle(sx, sy) {
  const ss = scaleHandlePositions();
  for (let i = 0; i < ss.length; i++) {
    if (Math.hypot(ss[i].x - sx, ss[i].y - sy) <= 10) return i;
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
  activePointers.set(e.pointerId, p);
  if (activePointers.size === 2) {
    // A second finger turns the gesture into a pinch: wind down any
    // single-pointer drag cleanly before taking over.
    cancelDrag();
    hideDotMenu();
    hideHandleTip();
    startPinch();
    return;
  }
  if (activePointers.size > 2) return; // extra fingers don't disturb the pinch pair
  // Shift-drag: marquee to mark (or unmark) an area of modules as ignored.
  if (e.shiftKey && state.corners && state.sample) {
    drag = { mode: 'marquee', start: p, moved: false };
    hideDotMenu();
    hideHandleTip();
    return;
  }
  if (state.corners && hitRotHandle(p.x, p.y)) {
    const ip = screenToImg(p.x, p.y);
    const center = gridCenterImg();
    drag = {
      mode: 'rotate', start: p, moved: false, center,
      a0: Math.atan2(ip.y - center.y, ip.x - center.x),
      snap: rotatablePoints().map(pt => ({ pt, x: pt.x, y: pt.y })),
    };
    dragActive = true;
    hideDotMenu();
    hideHandleTip();
    return;
  }
  if (state.corners && hitMoveHandle(p.x, p.y)) {
    drag = {
      mode: 'move', start: p, moved: false,
      snap: rotatablePoints().map(pt => ({ pt, x: pt.x, y: pt.y })),
    };
    dragActive = true;
    hideDotMenu();
    hideHandleTip();
    return;
  }
  const si = state.corners ? hitScaleHandle(p.x, p.y) : -1;
  if (si >= 0) {
    const ip = screenToImg(p.x, p.y);
    // Anchor at the far corner: it stays put while width/height scale freely.
    const far = state.corners[(si + 2) % 4];
    const anchor = { x: far.x, y: far.y };
    drag = {
      mode: 'scale', start: p, moved: false, anchor,
      d0x: ip.x - anchor.x, d0y: ip.y - anchor.y,
      snap: rotatablePoints().map(pt => ({ pt, x: pt.x, y: pt.y })),
    };
    dragActive = true;
    hideDotMenu();
    hideHandleTip();
    return;
  }
  const hi = hitHandle(p.x, p.y);
  if (hi >= 0) {
    // Corners select immediately; diamonds only select once an actual drag starts,
    // because a plain click on a diamond toggles the module underneath instead.
    if (handleList()[hi].corner) state.selHandle = hi;
    drag = { mode: 'handle', idx: hi, start: p, moved: false };
    dragActive = true;
  } else {
    drag = { mode: 'maybe', start: p, moved: false, view: { ...state.view } };
  }
  draw();
}

function onPointerMove(e) {
  const p = canvasPos(e);
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, p);
  if (pinchMid) {
    if (!activePointers.has(e.pointerId)) return;
    const [a, b] = pinchPair();
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (pinchDist > 0) zoomAt(m, d / pinchDist);
    state.view.ox += m.x - pinchMid.x;
    state.view.oy += m.y - pinchMid.y;
    pinchDist = d;
    pinchMid = m;
    draw();
    return;
  }
  if (drag) {
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      drag.moved = true;
      // Snapshot the pre-drag state once, the moment a grid edit actually starts.
      if (['handle', 'rotate', 'scale', 'move'].includes(drag.mode)) pushHistory();
    }
    if (drag.moved) { hideDotMenu(); hideHandleTip(); }
    if (drag.mode === 'marquee') {
      if (drag.moved) {
        state.marquee = { x0: drag.start.x, y0: drag.start.y, x1: p.x, y1: p.y };
        draw();
      }
      return;
    }
    if (drag.mode === 'rotate' && drag.moved) {
      const ip = screenToImg(p.x, p.y);
      const a = Math.atan2(ip.y - drag.center.y, ip.x - drag.center.x);
      const da = a - drag.a0;
      const cos = Math.cos(da), sin = Math.sin(da);
      for (const s of drag.snap) {
        const dx0 = s.x - drag.center.x, dy0 = s.y - drag.center.y;
        s.pt.x = drag.center.x + dx0 * cos - dy0 * sin;
        s.pt.y = drag.center.y + dx0 * sin + dy0 * cos;
      }
      setMessage(`rotated ${(da * 180 / Math.PI).toFixed(1)}°`);
      refresh(true);
      return;
    }
    // Translate the whole grid rigidly.
    if (drag.mode === 'move' && drag.moved) {
      const mx = dx / state.view.scale, my = dy / state.view.scale;
      for (const s of drag.snap) {
        s.pt.x = s.x + mx;
        s.pt.y = s.y + my;
      }
      setMessage(`moved ${mx.toFixed(0)}, ${my.toFixed(0)}px`);
      refresh(true);
      return;
    }
    // Scale the whole grid about the far corner, width and height independently.
    // Negative factors are allowed: dragging through the anchor flips the grid,
    // which is how mirrored QR codes are read.
    if (drag.mode === 'scale' && drag.moved) {
      const ip = screenToImg(p.x, p.y);
      const clampK = v => (v < 0 ? -1 : 1) * Math.min(20, Math.max(0.05, Math.abs(v)));
      const kx = Math.abs(drag.d0x) < 1e-6 ? 1 : clampK((ip.x - drag.anchor.x) / drag.d0x);
      const ky = Math.abs(drag.d0y) < 1e-6 ? 1 : clampK((ip.y - drag.anchor.y) / drag.d0y);
      for (const s of drag.snap) {
        s.pt.x = drag.anchor.x + (s.x - drag.anchor.x) * kx;
        s.pt.y = drag.anchor.y + (s.y - drag.anchor.y) * ky;
      }
      const mirror = kx < 0 && ky < 0 ? ' · flipped both ways' :
                     kx < 0 || ky < 0 ? ' · mirrored' : '';
      setMessage(`scaled ${(kx * 100).toFixed(0)}% × ${(ky * 100).toFixed(0)}%${mirror}`);
      refresh(true);
      return;
    }
    if (drag.mode === 'handle' && drag.moved) {
      state.selHandle = drag.idx;
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
  // A finger can't hover: without this, the finger left resting after a pinch
  // would pop the dot menu and hover UI under itself.
  if (e.pointerType === 'touch') return;
  // Hover: status, cross-highlight, dot menu / handle tip.
  if (state.corners && hitRotHandle(p.x, p.y)) {
    showHandleTip(rotHandlePosition(), 'drag to rotate');
    scheduleMenuHide();
    setHover(null);
    updateStatus(null);
    return;
  }
  if (state.corners && hitMoveHandle(p.x, p.y)) {
    showHandleTip(moveHandlePosition(), 'drag to move grid');
    scheduleMenuHide();
    setHover(null);
    updateStatus(null);
    return;
  }
  const si = state.corners ? hitScaleHandle(p.x, p.y) : -1;
  if (si >= 0) {
    showHandleTip(scaleHandlePositions()[si], 'drag to scale · past the far corner to mirror');
    scheduleMenuHide();
    setHover(null);
    updateStatus(null);
    return;
  }
  const m = hitModule(p.x, p.y);
  updateStatus(m);
  const hi = hitHandle(p.x, p.y);
  const h = hi >= 0 ? handleList()[hi] : null;
  if (h && h.corner) {
    showHandleTip(imgToScreen(h.pt), `${h.label} — drag to move`);
    hideDotMenu();
    setHover(null);
    return;
  }
  // A non-corner diamond shows its tip AND the dot menu for the module beneath it.
  if (h) showHandleTip(imgToScreen(h.pt), 'drag to move'); else hideHandleTip();
  if (m && !isLockedModule(m.i) && state.sample && modulePx() >= 5) showDotMenu(m, h ? 15 : 0);
  else scheduleMenuHide();
  if (m && state.result) {
    const g = state.result.moduleToCw[m.i];
    if (g >= 0) { setHoverFromCw(g, m.i); return; }
  }
  setHover(null);
}

function onPointerUp(e) {
  if (!activePointers.delete(e.pointerId)) return;
  if (pinchMid) {
    if (activePointers.size >= 2) startPinch(); // rebase to the remaining pair
    else endPinch();
    return;
  }
  const p = canvasPos(e);
  const wasDrag = drag;
  const wasActive = dragActive;
  drag = null;
  dragActive = false;
  if (!wasDrag) return;
  if (wasDrag.mode === 'marquee') {
    state.marquee = null;
    if (wasDrag.moved) applyMarquee(wasDrag.start, p);
    else draw();
    return;
  }
  if (!wasDrag.moved) {
    // A plain click on a diamond handle acts on the module beneath it; a click on
    // a corner handle keeps its selection; a click elsewhere toggles that module.
    const h = wasDrag.mode === 'handle' ? handleList()[wasDrag.idx] : null;
    if (h && h.corner) { draw(); return; }
    const m = hitModule(p.x, p.y);
    if (m && !isLockedModule(m.i)) {
      cycleOverride(m.i);
      refresh(false);
      if (state.sample && modulePx() >= 5) showDotMenu(m, h ? 15 : 0); // keep menu current
      return;
    }
    state.selHandle = -1;
    draw();
  } else if (wasActive) {
    refresh(true); // final full render after a handle drag
  } else if (wasDrag.mode === 'pan') {
    scheduleSave(); // view changed without a refresh
  }
}

// The browser took the pointer away (e.g. the OS interrupted the gesture):
// wind everything down without applying any click behavior.
function onPointerCancel(e) {
  if (!activePointers.delete(e.pointerId)) return;
  if (pinchMid) {
    if (activePointers.size >= 2) startPinch();
    else endPinch();
    return;
  }
  cancelDrag();
}

// End a drag without click behavior, committing whatever it already changed.
function cancelDrag() {
  const wasDrag = drag;
  const wasActive = dragActive;
  drag = null;
  dragActive = false;
  if (!wasDrag) return;
  if (wasDrag.mode === 'marquee') {
    state.marquee = null;
    draw();
  } else if (wasDrag.moved && wasActive) {
    refresh(true); // final full render after a handle drag
  } else if (wasDrag.mode === 'pan') {
    scheduleSave(); // view changed without a refresh
  }
}

function pinchPair() {
  const it = activePointers.values();
  return [it.next().value, it.next().value];
}

// (Re)baseline the pinch from the first two active pointers. Called on any
// finger-count change so a 3→2 transition never zooms against stale values.
function startPinch() {
  const [a, b] = pinchPair();
  pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function endPinch() {
  pinchDist = 0;
  pinchMid = null;
  scheduleSave();
}

// Mark every module whose center falls in the screen rect as ignored; if they
// all already are, unmark them instead (so shift-drag toggles cleanly).
function applyMarquee(a, b) {
  if (!state.corners || !state.sample) return;
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const size = gridSize();
  const hit = [];
  const isF = getLayout(state.version).isF;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      if (isF[i]) continue; // spec-fixed modules stay untouched
      const p = gridToScreen(c + 0.5, r + 0.5);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) hit.push(i);
    }
  }
  if (!hit.length) { draw(); return; }
  pushHistory();
  const allIgnored = hit.every(i => state.overrides.get(i) === 2);
  for (const i of hit) {
    if (allIgnored) state.overrides.delete(i);
    else state.overrides.set(i, 2);
  }
  setMessage(allIgnored
    ? `unmarked ${hit.length} ignored module${hit.length > 1 ? 's' : ''}`
    : `ignoring ${hit.length} module${hit.length > 1 ? 's' : ''} — their codewords decode as erasures`);
  refresh(false);
}

function onContextMenu(e) {
  e.preventDefault();
  const p = canvasPos(e);
  const m = hitModule(p.x, p.y);
  if (m && state.overrides.has(m.i)) {
    pushHistory();
    state.overrides.delete(m.i);
    refresh(false);
    if (menuModule === m.i) renderDotMenu();
  }
}

// ------------------------------------------------ dot menu / handle tip overlays

let menuModule = null;   // module idx the dot menu is showing for
let menuHideTimer = 0;

function showDotMenu(m, minGap = 0) {
  menuModule = m.i;
  clearTimeout(menuHideTimer);
  renderDotMenu();
  const size = gridSize();
  const r = (m.i / size) | 0, c = m.i % size;
  const p = gridToScreen(c + 0.5, r + 0.5);
  const dotR = Math.min(7, Math.max(1.4, modulePx() * 0.22));
  const el = $('dot-menu');
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y + Math.max(dotR + 5, minGap)}px`;
  el.style.transform = 'translateX(-50%)';
  el.hidden = false;
}

function renderDotMenu() {
  if (menuModule == null) return;
  const el = $('dot-menu');
  const ovr = state.overrides.get(menuModule);
  const sampled = state.sample ? state.sample.bits[menuModule] : 0;
  const rows = [
    { label: 'force □', active: ovr === 0 },
    { label: 'force ■', active: ovr === 1 },
    { label: 'ignore damaged', tail: '×', active: ovr === 2 },
    { label: `auto (${sampled ? '■' : '□'})`, active: ovr === undefined },
  ];
  el.textContent = '';
  for (const row of rows) {
    const d = document.createElement('div');
    d.className = 'dm-row' + (row.active ? ' active' : '');
    d.textContent = `${row.active ? '→' : ' '} ${row.label}`;
    if (row.tail) {
      const ic = document.createElement('span');
      ic.className = 'dm-x';
      ic.textContent = row.tail;
      d.appendChild(ic);
    }
    el.appendChild(d);
  }
  const help = document.createElement('div');
  help.className = 'dm-help';
  help.textContent = 'click to change · right-click to clear';
  el.appendChild(help);
}

function hideDotMenu() {
  if (menuModule == null) return;
  menuModule = null;
  $('dot-menu').hidden = true;
}

// Tiny delay only — enough to ride out pointer jitter between modules; the
// tooltip isn't interactive, so it doesn't need to outlive the hover.
function scheduleMenuHide() {
  clearTimeout(menuHideTimer);
  menuHideTimer = setTimeout(hideDotMenu, 40);
}

function showHandleTip(p, text) {
  const el = $('handle-tip');
  el.textContent = text;
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y - 14}px`;
  el.style.transform = 'translate(-50%, -100%)';
  el.hidden = false;
}

function hideHandleTip() {
  $('handle-tip').hidden = true;
}

// Cycle in menu order, top to bottom: force light -> force dark -> ignore -> auto.
function cycleOverride(i) {
  if (isLockedModule(i)) return;
  pushHistory();
  const cur = state.overrides.get(i);
  if (cur === undefined) state.overrides.set(i, 0);
  else if (cur === 0) state.overrides.set(i, 1);
  else if (cur === 1) state.overrides.set(i, 2);
  else state.overrides.delete(i);
}

function onWheel(e) {
  if (!state.imgCanvas) return;
  e.preventDefault();
  hideDotMenu();
  hideHandleTip();
  zoomAt(canvasPos(e), Math.pow(1.0015, -e.deltaY));
  draw();
  scheduleSave();
}

// Zoom the view by `factor` about canvas point `p`, keeping `p` fixed on screen.
function zoomAt(p, factor) {
  const ns = Math.min(200, Math.max(0.02, state.view.scale * factor));
  const k = ns / state.view.scale;
  state.view.ox = p.x - (p.x - state.view.ox) * k;
  state.view.oy = p.y - (p.y - state.view.oy) * k;
  state.view.scale = ns;
}

function onKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) doRedo(); else doUndo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
    e.preventDefault();
    doRedo();
    return;
  }
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
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
      pushHistory(`nudge${state.selHandle}`); // a burst of taps = one undo step
      break;
    default: moved = false;
  }
  switch (e.key) {
    case 'ArrowLeft': c.x -= px; break;
    case 'ArrowRight': c.x += px; break;
    case 'ArrowUp': c.y -= px; break;
    case 'ArrowDown': c.y += px; break;
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
    parts.push(`module (${m.r},${m.c}) lum ${state.sample.means[i].toFixed(0)} → ${bit ? '■' : '□'}` +
      (forced === 2 ? ' ignored' : forced !== undefined ? ' forced' : ''));
    const exp = expectedBit(i, getLayout(state.version).expected, dynamicExpected());
    if (exp >= 0 && exp !== bit && forced !== 2) parts.push(`expected ${exp ? '■' : '□'}`);
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
  const erasedTotal = res.blocks.reduce((s, b) => s + (b.erasedCount || 0), 0);
  let st, cls;
  if (failed === 0 && !res.parsed.error) {
    st = fixedTotal ? `OK — ${fixedTotal} codeword${fixedTotal > 1 ? 's' : ''} corrected` : 'OK';
    if (erasedTotal) st += ` (${erasedTotal} erased)`;
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
      (blk.status === 'fail' ? '✕' : blk.status === 'fixed' ? `+${blk.fixedCount}` : '✓') +
      (blk.erasedCount ? ` e${blk.erasedCount}` : '');
    row.appendChild(head);
    blockHeadEls[blk.index] = head;
    for (const g of blk.globals) {
      const cw = res.cw[g];
      const sp = document.createElement('span');
      sp.className = 'cw' + (cw.isEC ? ' ec' : '') + (cw.fixed ? ' fixed' : '') + (cw.erased ? ' erased' : '');
      sp.dataset.g = g;
      sp.textContent = cw.val.toString(16).padStart(2, '0');
      sp.title = `cw #${g} · block ${cw.block + 1} · ${cw.isEC ? 'EC' : 'data'}` +
        (cw.erased ? ' · erased (has ignored modules)' : '') +
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

  let nForced = 0, nIgnored = 0;
  for (const v of state.overrides.values()) v === 2 ? nIgnored++ : nForced++;
  $('override-info').textContent =
    `${nForced} forced · ${nIgnored} ignored`;

  // Known-pattern agreement (alignment quality signal).
  const mm = countMismatches();
  const fnEl = $('fn-info');
  if (mm) {
    let txt = mm.bad === 0
      ? `known patterns: all ${mm.total} match`
      : `known patterns: ${mm.bad}/${mm.total} mismatched`;
    let err = mm.bad > 0;
    const quiet = state.sample && state.sample.quiet;
    if (quiet) {
      const dark = quiet.reduce((n, m) => n + m.bit, 0);
      txt += dark === 0 ? ' · quiet zone clean' : ` · quiet zone: ${dark} dark`;
      err = err || dark > 0;
    }
    fnEl.textContent = txt;
    fnEl.className = 'mono-line' + (err ? ' err' : ' dim');
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
      chip.textContent = `B${blk.index + 1}${blk.status === 'fail' ? '✕' : blk.status === 'fixed' ? `+${blk.fixedCount}` : '✓'}` +
        (blk.erasedCount ? `e${blk.erasedCount}` : '');
      chip.title = `block ${blk.index + 1}: ${blk.dataGlobal.length} data + ${blk.ecGlobal.length} EC codewords — ` +
        (blk.status === 'fail' ? 'uncorrectable' : blk.status === 'fixed' ? `${blk.fixedCount} corrected` : 'clean') +
        (blk.erasedCount ? ` · ${blk.erasedCount} erased (budget: 2·errors + erasures ≤ ${res.ecPer})` : '');
      bl.appendChild(chip);
      blockChipEls[blk.index] = chip;
    }
  }
}
