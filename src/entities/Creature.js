import { gameEvents } from '../engine/EventEmitter.js';
import { toCell } from '../engine/GridEngine.js';
import { StalkBehavior } from './behaviors/StalkBehavior.js';

export class Creature {
  /**
   * @param {{ definition: { id: string; movesEveryNPlayerMoves?: number }; startX: number; startY: number }} opts
   */
  constructor({ definition, startX, startY }) {
    /** @type {{ id: string; movesEveryNPlayerMoves?: number }} */
    this._definition = definition;
    this.id = definition.id;
    this.pos = { x: startX, y: startY };
    this.moveCounter = 0;
    this.behavior = new StalkBehavior();
    /** Registry `behavior` (e.g. `"stalk"` for stalker). */
    this._isStalker = definition.behavior === 'stalk';
  }

  /**
   * @param {{ x: number; y: number }} playerPos
   * @param {number[][] | { grid: number[][]; objects?: Array<{ cell: string; type: string }> }} grid
   */
  onPlayerMoved(playerPos, grid) {
    this.moveCounter += 1;
    if (this.moveCounter < this._definition.movesEveryNPlayerMoves) return;

    this.moveCounter = 0;
    const px = this.pos.x;
    const py = this.pos.y;
    const next = this.behavior.getNextPosition(this.pos, playerPos, grid);
    this.pos = next;

    if (this._isStalker && (next.x !== px || next.y !== py)) {
      gameEvents.emit('STALKER_MOVE', { id: this.id, x: next.x, y: next.y });
    }

    gameEvents.emit('CREATURE_TICK', {
      id: this.id,
      pos: { ...this.pos },
      creatureTypeId: this._definition.registryCreatureId,
    });

    if (this.pos.x === playerPos.x && this.pos.y === playerPos.y) {
      gameEvents.emit('PLAYER_DEATH', {
        cell: toCell(this.pos.x, this.pos.y),
        x: this.pos.x,
        y: this.pos.y,
      });
    }
  }

  /**
   * @returns {{ x: number; y: number }}
   */
  getPos() {
    return { x: this.pos.x, y: this.pos.y };
  }
}
