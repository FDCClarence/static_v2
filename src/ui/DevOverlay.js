/** Live grid debug view (dev only). */

const HUD_H = 32;
const PAD = 40;
const HUD_PAD_X = 12;

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
  }

  /**
   * @param {HTMLCanvasElement} canvas
   */
  start(canvas) {
    this.stop();
    this._canvas = canvas;
    this._syncCanvasBufferSize();
    this._resizeObserver = new ResizeObserver(() => {
      this._syncCanvasBufferSize();
      this.draw();
    });
    this._resizeObserver.observe(canvas);
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
    this._gridState = null;
    this._playerPos = null;
    this._facingDirection = 'N';
    this._entities = [];
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

    const availW = cssW - 2 * PAD;
    const availH = cssH - 2 * PAD - HUD_H;
    const denom = Math.max(gridW, gridH, 1);
    const cellSize = Math.floor(Math.min(availW, availH) / denom);

    const gridPxW = gridW * cellSize;
    const gridPxH = gridH * cellSize;
    const offsetX = PAD + (availW - gridPxW) / 2;
    const offsetY = PAD + (availH - gridPxH) / 2;

    const px = this._playerPos;
    const ex = px?.x ?? -1;
    const ey = px?.y ?? -1;

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        ctx.save();
        ctx.translate(offsetX + gx * cellSize, offsetY + gy * cellSize);

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

        if (isPlayer) {
          const rad = FACING_TO_RAD[this._facingDirection] ?? 0;
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

        ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        ctx.fillStyle = '#333';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${gx},${gy}`, 8, cellSize - 8);

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
        ? `(${px.x},${px.y})`
        : '(—)';
    const creatureCount = this._creatureCount();
    const stateStr =
      (this._gridState && typeof this._gridState.state === 'string' && this._gridState.state) ||
      'PLAYING';

    const line = `FACING: ${this._facingDirection}  |  PLAYER: ${playerStr}  |  CREATURES: ${creatureCount}  |  STATE: ${stateStr}`;

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
