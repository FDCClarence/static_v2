/** Live grid debug view (dev only). */

import { gameEvents } from '../engine/EventEmitter.js';

const DEV_OVERRIDE =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('dev') === '1';
const IS_LOCALHOST =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
const IS_DEV_BUILD = Boolean(import.meta?.env?.DEV) || DEV_OVERRIDE || IS_LOCALHOST;

const HUD_H = 32;
const PAD = 40;
const HUD_PAD_X = 12;
const LABEL_MARGIN = 24;

/** @param {number} deg */
function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** @type {Record<string, number>} */
const FACING_TO_RAD = {
  N: 0,
  NE: Math.PI / 4,
  E: Math.PI / 2,
  SE: (3 * Math.PI) / 4,
  S: Math.PI,
  SW: (5 * Math.PI) / 4,
  W: (3 * Math.PI) / 2,
  NW: (7 * Math.PI) / 4,
};

/**
 * @typedef {0 | 1 | { abbrev?: string; type?: string }} CellValue
 * @typedef {{ width?: number; height?: number; cells?: CellValue[][]; state?: string }} GridStateInput
 * @typedef {{ x: number; y: number }} GridPos
 * @typedef {GridPos & { kind?: string }} EntityInput
 */

export class DevOverlay {
  constructor() {
    /** @type {HTMLCanvasElement | null} */
    this._canvas = null;
    /** @type {ReturnType<typeof requestAnimationFrame> | null} */
    this._raf = null;
    /** @type {ResizeObserver | null} */
    this._resizeObserver = null;

    /** @type {GridStateInput | null} */
    this._gridState = null;
    /** @type {GridPos | null} */
    this._playerPos = null;
    /** @type {string} */
    this._facingDirection = 'N';
    /** @type {EntityInput[]} */
    this._entities = [];
    /** Smoothed compass heading (deg) from {@link gameEvents} INPUT_TICK for arrow rotation. */
    this._gyroHeadingDeg = 0;
    /** @type {boolean} */
    this._hasGyroHeading = false;

    this._onInputTick = this._onInputTick.bind(this);

    if (IS_DEV_BUILD) {
      gameEvents.on('INPUT_TICK', this._onInputTick);
    }
  }

  /**
   * @param {unknown} detail
   */
  _onInputTick(detail) {
    if (!detail || typeof detail !== 'object') return;
    const h = /** @type {{ heading?: unknown }} */ (detail).heading;
    if (typeof h !== 'number' || !Number.isFinite(h)) return;
    this._gyroHeadingDeg = normalizeDeg(h);
    this._hasGyroHeading = true;
  }

  /**
   * @param {HTMLCanvasElement} canvas
   */
  start(canvas) {
    this.stop();
    this._canvas = canvas;
    this._syncCanvasBufferSize();
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => {
        this._syncCanvasBufferSize();
        this.draw();
      });
      this._resizeObserver.observe(canvas);
    }
    const loop = () => {
      if (!this._canvas) {
        this._raf = null;
        return;
      }
      this._raf = requestAnimationFrame(loop);
      this.draw();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf != null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this._resizeObserver && this._canvas) {
      this._resizeObserver.unobserve(this._canvas);
    }
    this._resizeObserver = null;
    this._canvas = null;
  }

  /**
   * @param {GridStateInput | null | undefined} gridState
   * @param {GridPos | null | undefined} playerPos
   * @param {string | null | undefined} facingDirection
   * @param {EntityInput[] | null | undefined} entities
   */
  update(gridState, playerPos, facingDirection, entities) {
    this._gridState = gridState ?? null;
    this._playerPos = playerPos ?? null;
    this._facingDirection = facingDirection != null ? String(facingDirection).toUpperCase() : 'N';
    this._entities = Array.isArray(entities) ? entities : [];
  }

  resize() {
    this._syncCanvasBufferSize();
    this.draw();
  }

  _syncCanvasBufferSize() {
    if (!this._canvas) return;
    const rect = this._canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._canvas.width = Math.floor(rect.width * dpr);
    this._canvas.height = Math.floor(rect.height * dpr);
    this._canvas.style.width = `${rect.width}px`;
    this._canvas.style.height = `${rect.height}px`;
  }

  draw() {
    const canvas = this._canvas;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;

    const dpr = canvas.width / cssW;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { gridW, gridH, cells } = this._normalizeGrid(this._gridState);

    const denom = Math.max(gridW, gridH, 1);
    const cellSize = Math.floor(
      Math.min(cssW - 80 - LABEL_MARGIN, cssH - 80 - LABEL_MARGIN) / denom,
    );

    const gridPxW = gridW * cellSize;
    const gridPxH = gridH * cellSize;
    const contentAvailW = cssW - 2 * PAD;
    const contentAvailH = cssH - 2 * PAD - HUD_H;
    const blockLeft = PAD + (contentAvailW - (LABEL_MARGIN + gridPxW)) / 2;
    const blockTop = PAD + (contentAvailH - (LABEL_MARGIN + gridPxH)) / 2;
    const gridOriginX = blockLeft + LABEL_MARGIN;
    const gridOriginY = blockTop + LABEL_MARGIN;

    const px = this._playerPos;
    const ex = px?.x ?? -1;
    const ey = px?.y ?? -1;

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let col = 0; col < gridW; col++) {
      const letter = String.fromCharCode(65 + col);
      ctx.fillText(
        letter,
        gridOriginX + col * cellSize + cellSize / 2,
        gridOriginY - 8,
      );
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let row = 0; row < gridH; row++) {
      ctx.fillText(String(row + 1), gridOriginX - 8, gridOriginY + row * cellSize + cellSize / 2);
    }

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        ctx.save();
        ctx.translate(gridOriginX + gx * cellSize, gridOriginY + gy * cellSize);

        const cell = cells[gy]?.[gx] ?? 0;
        const isPlayer = gx === ex && gy === ey;
        const kind = this._cellKind(cell, isPlayer);

        if (kind === 'player') {
          ctx.fillStyle = '#0a2a0a';
          ctx.fillRect(0, 0, cellSize, cellSize);
          ctx.strokeStyle = '#00ff44';
          ctx.lineWidth = 2;
          ctx.strokeRect(1, 1, cellSize - 2, cellSize - 2);
        } else if (kind === 'wall') {
          ctx.fillStyle = '#333';
          ctx.fillRect(0, 0, cellSize, cellSize);
          ctx.strokeStyle = '#444';
          ctx.lineWidth = 1;
          ctx.strokeRect(0.5, 0.5, cellSize - 1, cellSize - 1);
        } else if (kind === 'object') {
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(0, 0, cellSize, cellSize);
          ctx.strokeStyle = '#2a2a5e';
          ctx.lineWidth = 1;
          ctx.strokeRect(0.5, 0.5, cellSize - 1, cellSize - 1);
        } else {
          ctx.fillStyle = '#111';
          ctx.fillRect(0, 0, cellSize, cellSize);
          ctx.strokeStyle = '#222';
          ctx.lineWidth = 1;
          ctx.strokeRect(0.5, 0.5, cellSize - 1, cellSize - 1);
        }

        if (kind === 'wall') {
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
          ctx.fillStyle = '#444';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('█', cellSize / 2, cellSize / 2);
        } else if (kind === 'object') {
          const abbrev = this._cellAbbrev(cell);
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
          ctx.fillStyle = '#6666ff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(abbrev, cellSize / 2, cellSize / 2);
        }

        if (this._creatureAt(gx, gy)) {
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
          ctx.fillStyle = '#ff4444';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('C', cellSize / 2, cellSize / 2);
        }

        ctx.save();
        ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        ctx.fillStyle = '#333';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`${String.fromCharCode(65 + gx)}${gy + 1}`, 3, 10);
        ctx.restore();

        if (isPlayer) {
          const rad = this._hasGyroHeading
            ? (this._gyroHeadingDeg * Math.PI) / 180
            : FACING_TO_RAD[this._facingDirection] ?? 0;
          const inset = 6;
          const cx = cellSize / 2;
          const cy = cellSize / 2;
          const reach = cellSize / 2 - inset;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(rad);
          ctx.fillStyle = '#00ff44';
          ctx.beginPath();
          ctx.moveTo(0, -reach);
          ctx.lineTo(-reach * 0.55, reach * 0.45);
          ctx.lineTo(reach * 0.55, reach * 0.45);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        ctx.restore();
      }
    }

    this._drawHud(ctx, cssW, cssH);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cssW
   * @param {number} cssH
   */
  _drawHud(ctx, cssW, cssH) {
    const y0 = cssH - HUD_H;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, y0, cssW, HUD_H);

    const px = this._playerPos;
    const playerStr =
      px != null && Number.isFinite(px.x) && Number.isFinite(px.y)
        ? `${String.fromCharCode(65 + px.x)}${px.y + 1}`
        : '—';
    const creatureCount = this._creatureCount();
    const stateStr =
      (this._gridState && typeof this._gridState.state === 'string' && this._gridState.state) ||
      'PLAYING';

    const line = `PLAYER: ${playerStr}  |  FACING: ${this._facingDirection}  |  CREATURES: ${creatureCount}  |  STATE: ${stateStr}`;

    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(line, HUD_PAD_X, y0 + HUD_H / 2);
  }

  _creatureCount() {
    return this._entities.filter((e) => e && this._isCreatureEntity(e)).length;
  }

  /**
   * @param {EntityInput} e
   */
  _isCreatureEntity(e) {
    if (e.kind === 'creature') return true;
    if (e.kind === 'object') return false;
    return true;
  }

  /**
   * @param {number} gx
   * @param {number} gy
   */
  _creatureAt(gx, gy) {
    return this._entities.some((e) => {
      if (!e || !this._isCreatureEntity(e)) return false;
      const x = e.x;
      const y = e.y;
      return Number.isFinite(x) && Number.isFinite(y) && x === gx && y === gy;
    });
  }

  /**
   * @param {GridStateInput | null} gs
   */
  _normalizeGrid(gs) {
    const cells = gs?.cells;
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
      return { gridW: 1, gridH: 1, cells: [[0]] };
    }
    const gridH = typeof gs.height === 'number' ? gs.height : cells.length;
    const gridW =
      typeof gs.width === 'number'
        ? gs.width
        : Math.max(1, ...cells.map((row) => (Array.isArray(row) ? row.length : 0)));

    /** @type {CellValue[][]} */
    const normalized = [];
    for (let y = 0; y < gridH; y++) {
      const row = Array.isArray(cells[y]) ? cells[y] : [];
      /** @type {CellValue[]} */
      const out = [];
      for (let x = 0; x < gridW; x++) {
        out.push(row[x] !== undefined ? row[x] : 0);
      }
      normalized.push(out);
    }
    return { gridW, gridH, cells: normalized };
  }

  /**
   * @param {CellValue} cell
   * @param {boolean} isPlayer
   */
  _cellKind(cell, isPlayer) {
    if (isPlayer) return 'player';
    if (cell === 1 || cell === 'wall') return 'wall';
    if (cell === 0 || cell === 'floor') return 'floor';
    if (cell != null && typeof cell === 'object') {
      if ('abbrev' in cell || 'type' in cell) return 'object';
    }
    return 'floor';
  }

  /**
   * @param {CellValue} cell
   */
  _cellAbbrev(cell) {
    if (cell != null && typeof cell === 'object') {
      const a = cell.abbrev ?? cell.type;
      if (typeof a === 'string' && a.length > 0) return a.toUpperCase();
    }
    return '?';
  }
}

export const devOverlay = new DevOverlay();

/** @param {HTMLCanvasElement} canvas */
export function start(canvas) {
  devOverlay.start(canvas);
}

export function stop() {
  devOverlay.stop();
}

/**
 * @param {GridStateInput | null | undefined} gridState
 * @param {GridPos | null | undefined} playerPos
 * @param {string | null | undefined} facingDirection
 * @param {EntityInput[] | null | undefined} entities
 */
export function update(gridState, playerPos, facingDirection, entities) {
  devOverlay.update(gridState, playerPos, facingDirection, entities);
}

export function resize() {
  devOverlay.resize();
}
