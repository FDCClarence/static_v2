/**
 * Grid state, movement, collision. Internal logic uses { x, y }; cell strings are for JSON and events.
 */
import { gameEvents } from './EventEmitter.js';

/** @type {Record<string, { dx: number; dy: number }>} */
const DIRECTION_DELTA = {
  N: { dx: 0, dy: -1 },
  NE: { dx: 1, dy: -1 },
  E: { dx: 1, dy: 0 },
  SE: { dx: 1, dy: 1 },
  S: { dx: 0, dy: 1 },
  SW: { dx: -1, dy: 1 },
  W: { dx: -1, dy: 0 },
  NW: { dx: -1, dy: -1 },
};
const OPPOSITE_DIRECTION = {
  N: 'S',
  NE: 'SW',
  E: 'W',
  SE: 'NW',
  S: 'N',
  SW: 'NE',
  W: 'E',
  NW: 'SE',
};

/**
 * @param {string} cellStr
 * @returns {{ x: number; y: number }}
 */
export function parseCell(cellStr) {
  const s = String(cellStr).trim();
  const col = s.charAt(0).toUpperCase().charCodeAt(0) - 65;
  const row = parseInt(s.slice(1), 10) - 1;
  return { x: col, y: row };
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
export function toCell(x, y) {
  return String.fromCharCode(65 + x) + (y + 1);
}

/** Alias of {@link toCell} for existing call sites (e.g. audio). */
export const formatCell = toCell;

export class GridEngine {
  /**
   * @param {import('./EventEmitter.js').EventEmitter} [emitter]
   */
  constructor(emitter = gameEvents) {
    this._emitter = emitter;

    /** @type {boolean} */
    this._loaded = false;
    /** @type {'PLAYING' | 'DEAD'} */
    this._gameState = 'PLAYING';

    this._gridWidth = 0;
    this._gridHeight = 0;
    /** @type {number[][]} terrain 0=floor, 1=wall, 2=object marker */
    this._terrain = [];
    /** @type {Map<string, { id: string; type: string; x: number; y: number; devLabel?: string }>} */
    this._objectsByKey = new Map();
    /** @type {{ id: string; creatureType: string; x: number; y: number }[]} */
    this._creatures = [];
    /** @type {{ x: number; y: number }} */
    this._playerPos = { x: 0, y: 0 };
    /** @type {{ x: number; y: number }} */
    this._playerStart = { x: 0, y: 0 };
    /** @type {string} */
    this._facingDirection = 'N';

    /** @type {unknown} */
    this._levelMeta = null;
    /** @type {boolean} */
    this._hasLevelKey = false;

    this._onMoveIntent = this._onMoveIntent.bind(this);
    this._onFacingChanged = this._onFacingChanged.bind(this);
    this._onResetGame = this._onResetGame.bind(this);

    this._emitter.on('MOVE_INTENT', this._onMoveIntent);
    this._emitter.on('FACING_CHANGED', this._onFacingChanged);
    this._emitter.on('RESET_GAME', this._onResetGame);
  }

  /**
   * @param {unknown} data
   */
  loadLevel(data) {
    if (!data || typeof data !== 'object') return;

    const d = /** @type {Record<string, unknown>} */ (data);
    const w = Number(d.gridWidth);
    const h = Number(d.gridHeight);
    const rawGrid = d.grid;
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Array.isArray(rawGrid)) return;

    this._gridWidth = w;
    this._gridHeight = h;
    this._terrain = rawGrid.map((row) =>
      Array.isArray(row) ? row.map((v) => Number(v)) : [],
    );
    this._objectsByKey.clear();
    this._creatures = [];

    const objects = Array.isArray(d.objects) ? d.objects : [];
    for (const o of objects) {
      if (!o || typeof o !== 'object') continue;
      const ob = /** @type {Record<string, unknown>} */ (o);
      if (typeof ob.id !== 'string' || typeof ob.cell !== 'string') continue;
      const { x, y } = parseCell(ob.cell);
      const type = typeof ob.type === 'string' ? ob.type : 'object';
      const devLabel = typeof ob.devLabel === 'string' ? ob.devLabel : undefined;
      this._objectsByKey.set(`${x},${y}`, { id: ob.id, type, x, y, devLabel });
    }

    const creatures = Array.isArray(d.creatures) ? d.creatures : [];
    for (const c of creatures) {
      if (!c || typeof c !== 'object') continue;
      const cr = /** @type {Record<string, unknown>} */ (c);
      if (typeof cr.id !== 'string' || typeof cr.cell !== 'string') continue;
      const { x, y } = parseCell(cr.cell);
      const creatureType = typeof cr.creatureType === 'string' ? cr.creatureType : 'unknown';
      this._creatures.push({ id: cr.id, creatureType, x, y });
    }

    const ps = d.playerStart;
    if (ps && typeof ps === 'object' && typeof /** @type {{ cell?: unknown }} */ (ps).cell === 'string') {
      this._playerStart = parseCell(/** @type {{ cell: string }} */ (ps).cell);
    } else {
      this._playerStart = { x: 0, y: 0 };
    }
    this._playerPos = { ...this._playerStart };

    this._levelMeta = {
      id: d.id,
      reverbPreset: d.reverbPreset,
      ambientSound: d.ambientSound,
      exitCondition: d.exitCondition,
    };
    this._hasLevelKey = false;

    this._gameState = 'PLAYING';
    this._loaded = true;
    this._emitGridStateChanged();
  }

  /**
   * @param {string} direction8
   */
  move(direction8) {
    if (!this._loaded || this._gameState === 'DEAD') return;

    const dir = String(direction8 || 'N').toUpperCase();
    const delta = DIRECTION_DELTA[dir];
    if (!delta) return;

    this._facingDirection = dir;

    const nx = this._playerPos.x + delta.dx;
    const ny = this._playerPos.y + delta.dy;

    /** Diagonal-only: if diagonal target is blocked only by map edge or wall, try one cardinal step (slide). */
    const slide =
      delta.dx !== 0 &&
      delta.dy !== 0 &&
      (!this._inBounds(nx, ny) || this._isWall(nx, ny));

    if (!this._inBounds(nx, ny)) {
      if (slide) {
        const slid = this._tryDiagonalWallSlide(delta.dx, delta.dy);
        if (slid) return;
      }
      this._emitter.emit('PLAYER_BLOCKED', { x: nx, y: ny });
      this._emitGridStateChanged();
      return;
    }

    if (this._isWall(nx, ny)) {
      if (slide) {
        const slid = this._tryDiagonalWallSlide(delta.dx, delta.dy);
        if (slid) return;
      }
      this._emitter.emit('PLAYER_BLOCKED', { x: nx, y: ny, cell: toCell(nx, ny) });
      this._emitGridStateChanged();
      return;
    }

    const blockingObject = this._blockingObjectAt(nx, ny);
    if (blockingObject) {
      this._emitter.emit('PLAYER_BLOCKED', {
        x: nx,
        y: ny,
        cell: toCell(nx, ny),
        objectId: blockingObject.id,
        objectType: blockingObject.type,
      });
      this._emitGridStateChanged();
      return;
    }

    if (this._creatureAt(nx, ny)) {
      this._gameState = 'DEAD';
      this._emitter.emit('PLAYER_DEATH', { cell: toCell(nx, ny), x: nx, y: ny });
      this._emitGridStateChanged();
      return;
    }

    this._playerPos.x = nx;
    this._playerPos.y = ny;

    this._handlePlayerSteppedOnObject(nx, ny);

    this._emitter.emit('PLAYER_MOVED', {
      x: nx,
      y: ny,
      cell: toCell(nx, ny),
      floorType: 'default',
    });

    this._emitGridStateChanged();
  }

  /**
   * One-step slide when a diagonal target is only blocked by map edge or wall.
   * Tries horizontal (along dx) then vertical — first walkable cardinal wins (bounded, no multi-tile drift).
   * @param {number} dx
   * @param {number} dy
   * @returns {boolean}
   */
  _tryDiagonalWallSlide(dx, dy) {
    const px = this._playerPos.x;
    const py = this._playerPos.y;
    const candidates = [
      { nx: px + dx, ny: py },
      { nx: px, ny: py + dy },
    ];
    for (const { nx, ny } of candidates) {
      if (!this._inBounds(nx, ny) || this._isWall(nx, ny)) continue;
      const blockingObject = this._blockingObjectAt(nx, ny);
      if (blockingObject) continue;
      if (this._creatureAt(nx, ny)) {
        this._gameState = 'DEAD';
        this._emitter.emit('PLAYER_DEATH', { cell: toCell(nx, ny), x: nx, y: ny });
        this._emitGridStateChanged();
        return true;
      }
      this._playerPos.x = nx;
      this._playerPos.y = ny;
      this._handlePlayerSteppedOnObject(nx, ny);
      this._emitter.emit('PLAYER_MOVED', {
        x: nx,
        y: ny,
        cell: toCell(nx, ny),
        floorType: 'default',
      });
      this._emitGridStateChanged();
      return true;
    }
    return false;
  }

  /**
   * Diagonal wall / edge block only — same candidate order as {@link _tryDiagonalWallSlide}.
   * @param {number} dx
   * @param {number} dy
   * @returns {'clear' | 'death' | null} `null` = no slide escape
   */
  _peekSlideOutcome(dx, dy) {
    const px = this._playerPos.x;
    const py = this._playerPos.y;
    const candidates = [
      { nx: px + dx, ny: py },
      { nx: px, ny: py + dy },
    ];
    for (const { nx, ny } of candidates) {
      if (!this._inBounds(nx, ny) || this._isWall(nx, ny)) continue;
      const blockingObject = this._blockingObjectAt(nx, ny);
      if (blockingObject) continue;
      if (this._creatureAt(nx, ny)) return 'death';
      return 'clear';
    }
    return null;
  }

  /**
   * What would happen on a forward step with this delta — matches {@link move} / slide rules.
   * @param {number} dx
   * @param {number} dy
   * @returns {'clear' | 'blocked' | 'death'}
   */
  _peekForwardMoveOutcome(dx, dy) {
    const px = this._playerPos.x;
    const py = this._playerPos.y;
    const nx = px + dx;
    const ny = py + dy;
    const slide =
      dx !== 0 && dy !== 0 && (!this._inBounds(nx, ny) || this._isWall(nx, ny));

    if (!this._inBounds(nx, ny)) {
      if (slide) {
        const slid = this._peekSlideOutcome(dx, dy);
        if (slid != null) return slid;
      }
      return 'blocked';
    }

    if (this._isWall(nx, ny)) {
      if (slide) {
        const slid = this._peekSlideOutcome(dx, dy);
        if (slid != null) return slid;
      }
      return 'blocked';
    }

    const blockingObject = this._blockingObjectAt(nx, ny);
    if (blockingObject) return 'blocked';
    if (this._creatureAt(nx, ny)) return 'death';
    return 'clear';
  }

  interact() {
    if (!this._loaded || this._gameState === 'DEAD') return;

    const delta = DIRECTION_DELTA[this._facingDirection] ?? DIRECTION_DELTA.N;
    const tx = this._playerPos.x + delta.dx;
    const ty = this._playerPos.y + delta.dy;

    if (!this._inBounds(tx, ty)) return;

    const obj = this._objectsByKey.get(`${tx},${ty}`);
    if (obj) {
      this._emitter.emit('OBJECT_INTERACT', {
        objectId: obj.id,
        type: obj.type,
        cell: toCell(tx, ty),
        x: tx,
        y: ty,
      });
    }
  }

  _onMoveIntent(/** @type {unknown} */ detail) {
    if (!detail || typeof detail !== 'object') return;
    const payload = /** @type {{ facingDirection?: string; moveMode?: string }} */ (detail);
    if (typeof payload.facingDirection !== 'string') return;
    const dir =
      payload.moveMode === 'backward'
        ? (OPPOSITE_DIRECTION[payload.facingDirection.toUpperCase()] ?? payload.facingDirection)
        : payload.facingDirection;
    this.move(dir);
  }

  _onFacingChanged(/** @type {unknown} */ detail) {
    if (detail && typeof detail === 'object') {
      const fd = /** @type {{ facingDirection?: string }} */ (detail).facingDirection;
      if (typeof fd === 'string') this._facingDirection = fd;
    }
    if (this._loaded) this._emitGridStateChanged();
  }

  _onResetGame() {
    if (!this._loaded) return;
    this._gameState = 'PLAYING';
    this._playerPos = { ...this._playerStart };
    this._emitGridStateChanged();
  }

  /** Snapshot for pathfinding / creature AI (terrain + object types). */
  get grid() {
    const objects = [];
    for (const [, o] of this._objectsByKey) {
      objects.push({ id: o.id, type: o.type, cell: toCell(o.x, o.y) });
    }
    return {
      grid: this._terrain.map((row) => row.slice()),
      objects,
    };
  }

  get playerPos() {
    return { ...this._playerPos };
  }

  /**
   * When gameplay state is DEAD (e.g. creature reached the player), keep grid UI in sync.
   */
  markDeadState() {
    this._gameState = 'DEAD';
    this._emitGridStateChanged();
  }

  /**
   * @param {{ id: string; x: number; y: number }[]} updates
   */
  syncCreaturePositions(updates) {
    let changed = false;
    for (const { id, x, y } of updates) {
      const c = this._creatures.find((cr) => cr.id === id);
      if (c && (c.x !== x || c.y !== y)) {
        c.x = x;
        c.y = y;
        changed = true;
      }
    }
    if (changed) this._emitGridStateChanged();
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  _inBounds(x, y) {
    return x >= 0 && x < this._gridWidth && y >= 0 && y < this._gridHeight;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  _isWall(x, y) {
    return this._terrain[y]?.[x] === 1;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  _objectBlocks(x, y) {
    return this._blockingObjectAt(x, y) != null;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {{ id: string; type: string; x: number; y: number; devLabel?: string } | null}
   */
  _blockingObjectAt(x, y) {
    if (this._terrain[y]?.[x] === 2) {
      return { id: 'terrain-object', type: 'terrain-object', x, y };
    }
    const obj = this._objectsByKey.get(`${x},${y}`);
    if (!obj) return null;
    if (obj.type === 'key' || obj.type === 'door-unlocked') return null;
    return obj;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  _creatureAt(x, y) {
    return this._creatures.some((c) => c.x === x && c.y === y);
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  _handlePlayerSteppedOnObject(x, y) {
    const objectKey = `${x},${y}`;
    const obj = this._objectsByKey.get(objectKey);
    if (!obj) return;

    if (obj.type === 'key') {
      this._objectsByKey.delete(objectKey);
      this._hasLevelKey = true;
      this._unlockDoors(x, y);
      this._emitter.emit('KEY_COLLECTED', { objectId: obj.id, cell: toCell(x, y), x, y });
      return;
    }

    if (obj.type === 'door-unlocked') {
      this._emitter.emit('LEVEL_EXITED', {
        levelId: this._levelMeta && typeof this._levelMeta === 'object' ? this._levelMeta.id : undefined,
        doorId: obj.id,
        cell: toCell(x, y),
        x,
        y,
      });
    }
  }

  /**
   * @param {number} playerX Grid x of player after stepping (KEY_COLLECTED / DOOR_UNLOCKED fire before PLAYER_MOVED).
   * @param {number} playerY
   */
  _unlockDoors(playerX, playerY) {
    for (const [key, obj] of this._objectsByKey) {
      if (obj.type !== 'door-locked') continue;
      this._objectsByKey.set(key, { ...obj, type: 'door-unlocked', devLabel: 'OPN' });
      this._emitter.emit('DOOR_UNLOCKED', {
        objectId: obj.id,
        cell: toCell(obj.x, obj.y),
        x: obj.x,
        y: obj.y,
        playerX,
        playerY,
      });
    }
  }

  _buildDisplayGrid() {
    /** @type {(0 | 1 | { abbrev: string; type: string })[][]} */
    const cells = [];
    for (let y = 0; y < this._gridHeight; y++) {
      /** @type {(0 | 1 | { abbrev: string; type: string })[]} */
      const row = [];
      for (let x = 0; x < this._gridWidth; x++) {
        const t = this._terrain[y]?.[x] ?? 0;
        if (t === 1) {
          row.push(1);
          continue;
        }
        const ob = this._objectsByKey.get(`${x},${y}`);
        if (ob || t === 2) {
          const type = ob?.type ?? 'obj';
          const rawLabel = ob?.devLabel?.trim();
          const abbrev = rawLabel
            ? rawLabel.toUpperCase().slice(0, 3)
            : type.length <= 3
              ? type.toUpperCase()
              : type.slice(0, 3).toUpperCase();
          row.push({ abbrev, type });
        } else {
          row.push(0);
        }
      }
      cells.push(row);
    }
    return cells;
  }

  /** Re-send last grid snapshot (e.g. dev overlay toggled on after load). */
  republishGridState() {
    this._emitGridStateChanged();
  }

  _emitGridStateChanged() {
    if (!this._loaded) return;

    const delta = DIRECTION_DELTA[this._facingDirection] ?? DIRECTION_DELTA.N;
    const forwardOutcome = this._peekForwardMoveOutcome(delta.dx, delta.dy);
    const forwardBlocked = forwardOutcome === 'blocked';
    const forwardHostile = forwardOutcome === 'death';

    const grid = {
      width: this._gridWidth,
      height: this._gridHeight,
      cells: this._buildDisplayGrid(),
      state: this._gameState,
    };

    const entities = this._creatures.map((c) => ({
      x: c.x,
      y: c.y,
      kind: 'creature',
      id: c.id,
      creatureType: c.creatureType,
    }));

    this._emitter.emit('GRID_STATE_CHANGED', {
      grid,
      playerPos: { ...this._playerPos },
      facingDirection: this._facingDirection,
      entities,
      forwardThreat: {
        isBlocked: forwardBlocked,
        isHostile: forwardHostile,
        isUnsafe: forwardOutcome !== 'clear',
        isPassable: forwardOutcome === 'clear',
      },
    });
  }
}

export const gridEngine = new GridEngine();
