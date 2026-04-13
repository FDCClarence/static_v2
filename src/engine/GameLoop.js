/**
 * State machine: LOADING / PLAYING / DEAD / COMPLETE.
 * Creature spawning, player-move-driven AI, and level reload after death (via RESET_GAME from audio).
 */
import { gameEvents } from './EventEmitter.js';
import { gridEngine, parseCell, toCell } from './GridEngine.js';
import { Creature } from '../entities/Creature.js';
import creatureRegistry from '../data/creatures/registry.js';

const RANDOM_CREATURE_CELL = '__RANDOM__';

/**
 * Mutates level data in place: replaces creature `cell` values of `"__RANDOM__"` with a random
 * floor tile (terrain 0), avoiding player start, level objects, and fixed creature cells.
 * Call before `gridEngine.loadLevel(levelData)`.
 * @param {unknown} levelData
 */
export function resolveRandomCreatureSpawns(levelData) {
  if (!levelData || typeof levelData !== 'object') return;
  const d = /** @type {Record<string, unknown>} */ (levelData);
  const rawGrid = d.grid;
  if (!Array.isArray(rawGrid)) return;

  const creatures = d.creatures;
  if (!Array.isArray(creatures)) return;

  /** @type {Set<string>} */
  const taken = new Set();

  const ps = d.playerStart;
  if (ps && typeof ps === 'object' && typeof /** @type {{ cell?: unknown }} */ (ps).cell === 'string') {
    const { x, y } = parseCell(/** @type {{ cell: string }} */ (ps).cell);
    taken.add(`${x},${y}`);
  }

  const objects = d.objects;
  if (Array.isArray(objects)) {
    for (const o of objects) {
      if (!o || typeof o !== 'object') continue;
      const ob = /** @type {{ cell?: unknown }} */ (o);
      if (typeof ob.cell === 'string') {
        const { x, y } = parseCell(ob.cell);
        taken.add(`${x},${y}`);
      }
    }
  }

  for (const c of creatures) {
    if (!c || typeof c !== 'object') continue;
    const e = /** @type {{ cell?: unknown }} */ (c);
    if (typeof e.cell !== 'string' || e.cell === RANDOM_CREATURE_CELL) continue;
    const { x, y } = parseCell(e.cell);
    taken.add(`${x},${y}`);
  }

  /** @type {{ x: number; y: number }[]} */
  const candidates = [];
  const gridH = rawGrid.length;
  for (let y = 0; y < gridH; y++) {
    const row = rawGrid[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== 0) continue;
      const key = `${x},${y}`;
      if (taken.has(key)) continue;
      candidates.push({ x, y });
    }
  }

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = t;
  }

  let pick = 0;
  for (const c of creatures) {
    if (!c || typeof c !== 'object') continue;
    const e = /** @type {{ cell?: unknown }} */ (c);
    if (e.cell !== RANDOM_CREATURE_CELL) continue;
    if (pick >= candidates.length) break;
    const { x, y } = candidates[pick];
    pick += 1;
    taken.add(`${x},${y}`);
    e.cell = toCell(x, y);
  }
}

export class GameLoop {
  constructor() {
    /** @type {'LOADING' | 'PLAYING' | 'DEAD' | 'COMPLETE'} */
    this.state = 'LOADING';
    /** @type {Creature[]} */
    this.creatures = [];
    /** @type {(() => Promise<void>) | null} */
    this._reloadLevel = null;

    this._onPlayerMoved = this._onPlayerMoved.bind(this);
    this._onPlayerDeath = this._onPlayerDeath.bind(this);
    this._onResetGame = this._onResetGame.bind(this);

    /** Successful moves only — GridEngine does not emit this when it emitted PLAYER_BLOCKED. */
    gameEvents.on('PLAYER_MOVED', this._onPlayerMoved);
    gameEvents.on('PLAYER_DEATH', this._onPlayerDeath);
    /** Defer so AudioEventBus + GridEngine run first; reload runs after spatial clear. */
    gameEvents.on('RESET_GAME', this._onResetGame);
  }

  /**
   * @param {() => Promise<void>} fn Reload level JSON, `gridEngine.loadLevel`, audio, etc.
   */
  setReloadHandler(fn) {
    this._reloadLevel = fn;
  }

  /**
   * Call after `gridEngine.loadLevel(levelData)` while entering LOADING (initial load or full reset).
   * @param {unknown} levelData
   */
  onLevelLoading(levelData) {
    this.state = 'LOADING';
    this.creatures = [];
    gameEvents.emit('STALKER_IDLE_CLEAR');

    if (!levelData || typeof levelData !== 'object') {
      this.state = 'PLAYING';
      return;
    }

    const d = /** @type {Record<string, unknown>} */ (levelData);
    const raw = d.creatures;
    const list = Array.isArray(raw) ? raw : [];

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const e = /** @type {Record<string, unknown>} */ (entry);
      if (typeof e.id !== 'string' || typeof e.cell !== 'string') continue;
      const creatureType = typeof e.creatureType === 'string' ? e.creatureType : '';
      const reg = creatureRegistry.find((c) => c.id === creatureType);
      if (!reg) continue;

      const { x, y } = parseCell(e.cell);
      const speed = typeof reg.speed === 'number' && Number.isFinite(reg.speed) ? Math.max(1, Math.floor(reg.speed)) : 1;
      const definition = {
        ...reg,
        id: e.id,
        movesEveryNPlayerMoves: speed,
        registryCreatureId: reg.id,
      };
      this.creatures.push(new Creature({ definition, startX: x, startY: y }));
      gameEvents.emit('CREATURE_TICK', {
        id: e.id,
        pos: { x, y },
        creatureTypeId: reg.id,
      });
      if (reg.behavior === 'stalk') {
        gameEvents.emit('STALKER_SPAWNED', { id: e.id, x, y, creatureTypeId: reg.id });
      }
    }

    this.state = 'PLAYING';
  }

  _onPlayerMoved() {
    if (this.state !== 'PLAYING') return;

    const playerPos = gridEngine.playerPos;
    const grid = gridEngine.grid;

    for (const c of this.creatures) {
      c.onPlayerMoved(playerPos, grid);
    }

    gridEngine.syncCreaturePositions(this.creatures.map((c) => ({ id: c.id, x: c.pos.x, y: c.pos.y })));
  }

  _onPlayerDeath() {
    this.state = 'DEAD';
    gridEngine.markDeadState();
    
    for (const c of this.creatures) {
      c.moveCounter = 0;
    }
  }

  _onResetGame() {
    setTimeout(() => {
      void this.resetLevel();
    }, 0);
  }

  async resetLevel() {
    this.creatures = [];
    this.state = 'LOADING';
    if (this._reloadLevel) {
      await this._reloadLevel();
    } else {
      this.state = 'PLAYING';
    }
  }
}

export const gameLoop = new GameLoop();
