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
const PLAYER_ACCENT = '#6ad9ff';
const OBJECT_ACCENT = '#ffd166';
const GRID_STROKE = 'rgba(255, 255, 255, 0.09)';

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
    const gridRadius = Math.max(8, Math.floor(cellSize * 0.2));

    const px = this._playerPos;
    const ex = px?.x ?? -1;
    const ey = px?.y ?? -1;

    // Grid container card for a cleaner, modern frame.
    ctx.save();
    this._roundedRect(ctx, gridOriginX - 8, gridOriginY - 8, gridPxW + 16, gridPxH + 16, gridRadius + 4);
    const panelGrad = ctx.createLinearGradient(0, gridOriginY - 8, 0, gridOriginY + gridPxH + 8);
    panelGrad.addColorStop(0, 'rgba(26, 26, 26, 0.9)');
    panelGrad.addColorStop(1, 'rgba(10, 10, 10, 0.95)');
    ctx.fillStyle = panelGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    ctx.fillStyle = '#7a7a7a';
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

        const inset = 1;
        const inner = cellSize - inset * 2;
        if (kind === 'player') {
          const pGrad = ctx.createLinearGradient(0, inset, 0, inset + inner);
          pGrad.addColorStop(0, 'rgba(42, 62, 72, 0.98)');
          pGrad.addColorStop(1, 'rgba(18, 30, 36, 0.98)');
          ctx.fillStyle = pGrad;
          ctx.fillRect(inset, inset, inner, inner);
          ctx.strokeStyle = PLAYER_ACCENT;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(inset + 0.75, inset + 0.75, inner - 1.5, inner - 1.5);
          if (inner > 6) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(inset + 1.5, inset + 1.5, inner - 3, inner - 3);
            ctx.clip();
            const shine = ctx.createLinearGradient(0, inset, 0, inset + inner * 0.6);
            shine.addColorStop(0, 'rgba(255, 255, 255, 0.2)');
            shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = shine;
            ctx.fillRect(inset + 1.5, inset + 1.5, inner - 3, Math.max(2, inner * 0.45));
            ctx.restore();
          }
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.lineWidth = 1;
          ctx.strokeRect(inset + 1.5, inset + 1.5, inner - 3, inner - 3);
          ctx.restore();
        } else if (kind === 'wall') {
          const wGrad = ctx.createLinearGradient(0, inset, 0, inset + inner);
          wGrad.addColorStop(0, '#2f2f2f');
          wGrad.addColorStop(1, '#222');
          ctx.fillStyle = wGrad;
          ctx.fillRect(inset, inset, inner, inner);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.lineWidth = 1;
          ctx.strokeRect(inset + 0.5, inset + 0.5, inner - 1, inner - 1);
        } else if (kind === 'object') {
          const oGrad = ctx.createLinearGradient(0, inset, 0, inset + inner);
          oGrad.addColorStop(0, '#2b2618');
          oGrad.addColorStop(1, '#1b170f');
          ctx.fillStyle = oGrad;
          ctx.fillRect(inset, inset, inner, inner);
          ctx.strokeStyle = 'rgba(255, 209, 102, 0.38)';
          ctx.lineWidth = 1;
          ctx.strokeRect(inset + 0.5, inset + 0.5, inner - 1, inner - 1);
        } else {
          const fGrad = ctx.createLinearGradient(0, inset, 0, inset + inner);
          fGrad.addColorStop(0, '#151515');
          fGrad.addColorStop(1, '#0f0f0f');
          ctx.fillStyle = fGrad;
          ctx.fillRect(inset, inset, inner, inner);
          ctx.strokeStyle = GRID_STROKE;
          ctx.lineWidth = 1;
          ctx.strokeRect(inset + 0.5, inset + 0.5, inner - 1, inner - 1);
        }

        if (kind === 'wall') {
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
          ctx.fillStyle = '#666';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('█', cellSize / 2, cellSize / 2);
        } else if (kind === 'object') {
          const abbrev = this._cellAbbrev(cell);
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
          ctx.fillStyle = OBJECT_ACCENT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(abbrev, cellSize / 2, cellSize / 2);
        }

        if (this._creatureAt(gx, gy)) {
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
          ctx.fillStyle = '#d0d0d0';
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
          const inset = 8;
          const cx = cellSize / 2;
          const cy = cellSize / 2;
          const reach = cellSize / 2 - inset;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(rad);
          ctx.fillStyle = PLAYER_ACCENT;
          ctx.beginPath();
          ctx.moveTo(0, -reach);
          ctx.lineTo(-reach * 0.52, reach * 0.36);
          ctx.lineTo(reach * 0.52, reach * 0.36);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(2, reach * 0.22), 0, Math.PI * 2);
          ctx.fillStyle = '#e8f8ff';
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
    const grad = ctx.createLinearGradient(0, y0, 0, cssH);
    grad.addColorStop(0, 'rgba(18, 18, 18, 0.94)');
    grad.addColorStop(1, 'rgba(6, 6, 6, 0.98)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y0, cssW, HUD_H);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5);
    ctx.lineTo(cssW, y0 + 0.5);
    ctx.stroke();

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
    ctx.fillStyle = '#ededed';
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

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r
   */
  _roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
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
