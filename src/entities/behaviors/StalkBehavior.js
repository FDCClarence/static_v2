import objectRegistry from '../../data/objects/registry.js';
import { parseCell } from '../../engine/GridEngine.js';

/** @type {Map<string, { walkable?: boolean }>} */
const walkableByTypeId = new Map(
  objectRegistry.map((entry) => [entry.id, { walkable: entry.walkable === true }]),
);

/**
 * @param {unknown} grid
 * @returns {{ terrain: number[][]; typeAt: Map<string, string> }}
 */
function normalizeGrid(grid) {
  if (Array.isArray(grid)) {
    return { terrain: grid, typeAt: new Map() };
  }
  if (grid && typeof grid === 'object' && Array.isArray(/** @type {{ grid?: unknown }} */ (grid).grid)) {
    const g = /** @type {{ grid: number[][]; objects?: unknown }} */ (grid);
    const terrain = g.grid;
    /** @type {Map<string, string>} */
    const typeAt = new Map();
    const objects = g.objects;
    if (Array.isArray(objects)) {
      for (const o of objects) {
        if (!o || typeof o !== 'object') continue;
        const ob = /** @type {{ cell?: unknown; type?: unknown }} */ (o);
        if (typeof ob.cell !== 'string' || typeof ob.type !== 'string') continue;
        const { x, y } = parseCell(ob.cell);
        typeAt.set(`${x},${y}`, ob.type);
      }
    }
    return { terrain, typeAt };
  }
  return { terrain: [], typeAt: new Map() };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {{ x: number; y: number }} playerPos
 * @param {number[][]} terrain
 * @param {Map<string, string>} typeAt
 */
function isBlocked(x, y, playerPos, terrain, typeAt) {
  if (x === playerPos.x && y === playerPos.y) return false;

  const h = terrain.length;
  const w = terrain[0]?.length ?? 0;
  if (x < 0 || y < 0 || x >= w || y >= h) return true;

  const v = terrain[y]?.[x];
  if (v === 1) return true;
  if (v === 2) {
    const t = typeAt.get(`${x},${y}`);
    return walkableByTypeId.get(t ?? '')?.walkable !== true;
  }
  return false;
}

/** 8-neighbor offsets (matches GridEngine diagonals). */
const D8 = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export class StalkBehavior {
  /**
   * @param {{ x: number; y: number }} creaturePos
   * @param {{ x: number; y: number }} playerPos
   * @param {number[][] | { grid: number[][]; objects?: Array<{ cell: string; type: string }> }} grid
   * @returns {{ x: number; y: number }}
   */
  getNextPosition(creaturePos, playerPos, grid) {
    const { terrain, typeAt } = normalizeGrid(grid);
    if (
      creaturePos.x === playerPos.x &&
      creaturePos.y === playerPos.y
    ) {
      return { x: creaturePos.x, y: creaturePos.y };
    }

    const h = terrain.length;
    const w = terrain[0]?.length ?? 0;
    if (!h || !w) return { x: creaturePos.x, y: creaturePos.y };

    const startKey = `${creaturePos.x},${creaturePos.y}`;
    const goalKey = `${playerPos.x},${playerPos.y}`;

    if (isBlocked(creaturePos.x, creaturePos.y, playerPos, terrain, typeAt)) {
      return { x: creaturePos.x, y: creaturePos.y };
    }

    /** @type {Map<string, { x: number; y: number }>} */
    const parent = new Map();
    /** @type {{ x: number; y: number }[]} */
    const q = [];

    parent.set(startKey, creaturePos);
    q.push({ x: creaturePos.x, y: creaturePos.y });

    while (q.length) {
      const cur = q.shift();
      if (!cur) break;
      if (cur.x === playerPos.x && cur.y === playerPos.y) {
        let step = cur;
        while (true) {
          const p = parent.get(`${step.x},${step.y}`);
          if (!p) return { x: creaturePos.x, y: creaturePos.y };
          if (p.x === creaturePos.x && p.y === creaturePos.y) {
            return { x: step.x, y: step.y };
          }
          step = p;
        }
      }

      for (const [dx, dy] of D8) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nk = `${nx},${ny}`;
        if (parent.has(nk)) continue;
        if (isBlocked(nx, ny, playerPos, terrain, typeAt)) continue;
        parent.set(nk, { x: cur.x, y: cur.y });
        q.push({ x: nx, y: ny });
      }
    }

    return { x: creaturePos.x, y: creaturePos.y };
  }
}
