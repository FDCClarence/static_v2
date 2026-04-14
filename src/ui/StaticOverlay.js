/** Fullscreen visual-only overlay: chunky found-footage grain + VHS horizontal tear. pointer-events: none. */

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/** @type {HTMLCanvasElement | null} */
let grainCanvas = null;
/** @type {CanvasRenderingContext2D | null} */
let grainCtx = null;

/** @type {HTMLCanvasElement | null} */
let tearCanvas = null;
/** @type {CanvasRenderingContext2D | null} */
let tearCtx = null;

/** 0.0–1.0; raised externally to intensify both layers. */
let _intensity = 0.0;

/** Whether mount() has been called. */
let _mounted = false;

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function applyFullscreenStyle(/** @type {HTMLCanvasElement} */ canvas, zIndex) {
  const s = canvas.style;
  s.position = 'fixed';
  s.top = '0';
  s.left = '0';
  s.width = '100%';
  s.height = '100%';
  s.zIndex = String(zIndex);
  s.pointerEvents = 'none';
}

function syncSize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (grainCanvas) {
    grainCanvas.width = w;
    grainCanvas.height = h;
  }
  if (tearCanvas) {
    tearCanvas.width = w;
    tearCanvas.height = h;
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — Chunky film grain (8 fps via timestamp accumulator)
// ---------------------------------------------------------------------------

const GRAIN_INTERVAL_MS = 1000 / 8; // ~125 ms — degraded/stuttery
let grainLastTime = 0;

/** Armed to true when a tape-dropout burst frame should fire. */
let grainBurstPending = false;

/** Timestamp (ms) at which the next burst should be scheduled. */
let grainNextBurstAt = 0;

function scheduleNextBurst() {
  // 4–9 seconds from now.
  grainNextBurstAt = performance.now() + 4000 + Math.random() * 5000;
}

function tickGrain(/** @type {number} */ now) {
  if (!grainCtx || !grainCanvas) return;

  if (now >= grainNextBurstAt) {
    grainBurstPending = true;
    scheduleNextBurst();
  }

  if (now - grainLastTime < GRAIN_INTERVAL_MS) return;
  grainLastTime = now;

  const w = grainCanvas.width;
  const h = grainCanvas.height;

  grainCtx.clearRect(0, 0, w, h);

  const isBurst = grainBurstPending;
  grainBurstPending = false;

  // Scale particle count to canvas area so density is consistent across screens.
  // pixels/150 gives ~13 k particles on a 1080p screen — enough to read as grain.
  const pixelArea = w * h;
  const baseCount = Math.floor(pixelArea / 150) + Math.floor(_intensity * 5000);
  const grainCount = isBurst ? baseCount * 3 : baseCount;
  // const alphaMax = isBurst ? 0.45 : 0.18 + _intensity * 0.14;
  const alphaMax = isBurst ? 0.55 : 0.2 + _intensity * 0.14;

  for (let i = 0; i < grainCount; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const size = 1 + Math.random() * 3.5;
    const alpha = 0.05 + Math.random() * alphaMax;
    // Slight green tint — found footage cameras push green.
    const g = 180 + Math.floor(Math.random() * 75);
    grainCtx.fillStyle = `rgba(100,${g},100,${alpha})`;
    grainCtx.fillRect(x, y, size, size);
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — Horizontal tear (VHS sync error)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   y: number;
 *   height: number;
 *   offset: number;
 *   framesLeft: number;
 *   totalFrames: number;
 * }} TearEvent
 */

/** @type {TearEvent | null} */
let activeTear = null;

/** Timestamp (ms) at which the next tear should begin. */
let tearNextAt = 0;

function scheduleNextTear() {
  const isHighIntensity = _intensity > 0.6;
  const minMs = isHighIntensity ? 3000 : 8000;
  const rangeMs = isHighIntensity ? 5000 : 12000;
  tearNextAt = performance.now() + minMs + Math.random() * rangeMs;
}

function armTear() {
  const h = tearCanvas ? tearCanvas.height : window.innerHeight;
  const isHighIntensity = _intensity > 0.6;
  const maxOffset = isHighIntensity ? 32 : 18;

  activeTear = {
    y: Math.random() * h,
    height: 2 + Math.random() * 10,       // 2–12 px
    offset: (Math.random() * 2 - 1) * maxOffset, // –maxOffset to +maxOffset
    framesLeft: Math.floor(2 + Math.random() * 3), // 2–4 frames
    totalFrames: 0, // set below after clamping framesLeft
  };
  // totalFrames mirrors the initial framesLeft value so we can detect the last frame.
  activeTear.totalFrames = activeTear.framesLeft;

  scheduleNextTear();
}

function tickTear(/** @type {number} */ now) {
  if (!tearCtx || !tearCanvas) return;
  const w = tearCanvas.width;
  const h = tearCanvas.height;

  tearCtx.clearRect(0, 0, w, h);

  // Arm a new tear if the interval has elapsed and none is active.
  if (!activeTear && now >= tearNextAt) {
    armTear();
  }

  if (!activeTear) return;

  const isLastFrame = activeTear.framesLeft === 1;

  // Main tear band.
  tearCtx.fillStyle = 'rgba(255,255,255,0.12)';
  tearCtx.fillRect(activeTear.offset, activeTear.y, w, activeTear.height);

  // On the final frame, add a thinner accent band just above or below.
  if (isLastFrame) {
    const accentH = 1 + Math.random() * 2;          // 1–3 px
    const accentY = Math.random() < 0.5
      ? activeTear.y - accentH
      : activeTear.y + activeTear.height;
    tearCtx.fillStyle = 'rgba(255,255,255,0.22)';   // bright trailing edge
    tearCtx.fillRect(activeTear.offset, accentY, w, accentH);
  }

  activeTear.framesLeft--;
  if (activeTear.framesLeft <= 0) {
    activeTear = null;
  }
}

// ---------------------------------------------------------------------------
// Unified rAF loop
// ---------------------------------------------------------------------------

function loop(/** @type {number} */ now) {
  tickGrain(now);
  tickTear(now);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const StaticOverlay = {
  /**
   * Appends both canvases to document.body and starts the animation loops.
   * Safe to call only once; subsequent calls are no-ops.
   */
  mount() {
    if (_mounted) return;
    _mounted = true;

    // Layer 2 — tear canvas (z-index 998, behind grain)
    tearCanvas = document.createElement('canvas');
    applyFullscreenStyle(tearCanvas, 998);
    const tc = tearCanvas.getContext('2d');
    if (!tc) throw new Error('StaticOverlay: could not get 2d context for tear canvas');
    tearCtx = tc;

    // Layer 1 — grain canvas (z-index 999, topmost)
    grainCanvas = document.createElement('canvas');
    applyFullscreenStyle(grainCanvas, 999);
    const gc = grainCanvas.getContext('2d');
    if (!gc) throw new Error('StaticOverlay: could not get 2d context for grain canvas');
    grainCtx = gc;

    syncSize();

    // Stagger initial timers so nothing fires immediately on load.
    scheduleNextBurst();
    scheduleNextTear();

    document.body.appendChild(tearCanvas);
    document.body.appendChild(grainCanvas);

    window.addEventListener('resize', syncSize);

    requestAnimationFrame(loop);
  },

  /**
   * @param {number} value — 0.0 (baseline subtle) to 1.0 (fully intensified).
   */
  setIntensity(value) {
    _intensity = Math.max(0, Math.min(1, value));
  },
};
