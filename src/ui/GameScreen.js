/** Full-screen black game surface; optional dev grid overlay (dev builds only). */

import { gameEvents } from '../engine/EventEmitter.js';
import { gridEngine } from '../engine/GridEngine.js';
import * as DevOverlay from './DevOverlay.js';

const STYLE_ID = 'game-screen-styles';
const IS_DEV = import.meta.env.DEV;

export class GameScreen {
  constructor() {
    /** @type {HTMLDivElement | null} */
    this._root = null;
    /** @type {HTMLDivElement | null} */
    this._stage = null;
    /** @type {HTMLCanvasElement | null} */
    this._gameCanvas = null;
    /** @type {HTMLCanvasElement | null} */
    this._devCanvas = null;
    /** @type {HTMLButtonElement | null} */
    this._devToggle = null;
    /** @type {HTMLElement | null} */
    this._devLabel = null;

    this._devModeOn = false;
    this._gameReparented = false;

    this._onResize = this._onResize.bind(this);
    this._onDevToggle = this._onDevToggle.bind(this);
    this._onGridStateChanged = this._onGridStateChanged.bind(this);

    gameEvents.on('GRID_STATE_CHANGED', this._onGridStateChanged);

    this.render();
  }

  /**
   * @param {unknown} detail
   */
  _onGridStateChanged(detail) {
    if (!detail || typeof detail !== 'object') return;
    const d = /** @type {Record<string, unknown>} */ (detail);
    this.updateDevOverlay(d.grid, d.playerPos, d.facingDirection, d.entities);
  }

  render() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      let css = `
        .game-screen {
          position: fixed;
          inset: 0;
          z-index: 0;
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          background: #000;
          display: none;
          flex-direction: column;
        }

        .game-screen__stage {
          position: absolute;
          left: 0;
          right: 0;
          top: 0;
          bottom: 0;
          overflow: hidden;
        }

        .game-screen__game {
          display: block;
          width: 100%;
          height: 100%;
          vertical-align: top;
          touch-action: none;
        }
      `;
      if (import.meta.env.DEV) {
        css += `
        .game-screen--dev .game-screen__stage {
          top: 44px;
        }

        .game-screen__dev-bar {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 44px;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          z-index: 100;
          box-sizing: border-box;
          -webkit-user-select: none;
          user-select: none;
        }

        .game-screen__dev-title {
          margin: 0;
          font-size: 11px;
          letter-spacing: 0.15em;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          color: #ff4444;
        }

        .game-screen__dev-toggle-wrap {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .game-screen__dev-toggle-label {
          font-size: 11px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          min-width: 28px;
          text-align: right;
          transition: color 200ms ease;
        }

        .game-screen__dev-toggle-label--off {
          color: #444;
        }

        .game-screen__dev-toggle-label--on {
          color: #ff4444;
        }

        .game-screen__dev-toggle {
          position: relative;
          width: 40px;
          height: 22px;
          padding: 0;
          border: 1px solid #333;
          border-radius: 11px;
          background: transparent;
          cursor: pointer;
          flex-shrink: 0;
          box-sizing: border-box;
        }

        .game-screen__dev-toggle:focus-visible {
          outline: 2px solid #ff4444;
          outline-offset: 2px;
        }

        .game-screen__dev-toggle-knob {
          position: absolute;
          top: 50%;
          left: 2px;
          width: 16px;
          height: 16px;
          margin-top: -8px;
          border-radius: 50%;
          background: #ccc;
          transition: transform 200ms ease;
          pointer-events: none;
        }

        .game-screen__dev-toggle--on .game-screen__dev-toggle-knob {
          transform: translateX(20px);
        }

        .game-screen__dev-canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: none;
          pointer-events: none;
          z-index: 1;
        }
      `;
      }
      style.textContent = css;
      document.head.appendChild(style);
    }

    if (this._root) return;

    const root = document.createElement('div');
    root.className = 'game-screen';
    if (IS_DEV) root.classList.add('game-screen--dev');

    let devBarHtml = '';
    if (IS_DEV) {
      devBarHtml = `
        <div class="game-screen__dev-bar">
          <p class="game-screen__dev-title">DEV MODE</p>
          <div class="game-screen__dev-toggle-wrap">
            <span class="game-screen__dev-toggle-label game-screen__dev-toggle-label--off" aria-hidden="true">OFF</span>
            <button type="button" class="game-screen__dev-toggle" role="switch" aria-checked="false" aria-label="Dev overlay">
              <span class="game-screen__dev-toggle-knob"></span>
            </button>
          </div>
        </div>
      `;
    }

    const devCanvasHtml = IS_DEV
      ? `<canvas id="dev-canvas" class="game-screen__dev-canvas" aria-hidden="true"></canvas>`
      : '';

    root.innerHTML = `
      ${devBarHtml}
      <div class="game-screen__stage">
        ${devCanvasHtml}
      </div>
    `;

    this._stage = root.querySelector('.game-screen__stage');
    this._devCanvas = IS_DEV ? root.querySelector('#dev-canvas') : null;

    if (IS_DEV) {
      this._devToggle = root.querySelector('.game-screen__dev-toggle');
      this._devLabel = root.querySelector('.game-screen__dev-toggle-label');
      this._devToggle?.addEventListener('click', this._onDevToggle);
    }

    this._root = root;
    document.body.appendChild(root);
    this.hide();
  }

  _ensureGameCanvasInStage() {
    if (this._gameReparented || !this._stage) return;
    const game = document.getElementById('game');
    if (!game) return;
    game.classList.add('game-screen__game');
    this._stage.insertBefore(game, this._devCanvas ?? null);
    this._gameCanvas = game;
    this._gameReparented = true;
  }

  _onResize() {
    this.syncCanvasSize();
  }

  _onDevToggle() {
    this.setDevMode(!this._devModeOn);
  }

  /**
   * @param {boolean} on
   */
  setDevMode(on) {
    if (!IS_DEV || !this._devCanvas || !this._devToggle || !this._devLabel) return;

    this._devModeOn = on;
    this._devCanvas.style.display = on ? 'block' : 'none';

    this._devToggle.setAttribute('aria-checked', on ? 'true' : 'false');
    this._devToggle.classList.toggle('game-screen__dev-toggle--on', on);
    this._devLabel.textContent = on ? 'ON' : 'OFF';
    this._devLabel.classList.toggle('game-screen__dev-toggle-label--off', !on);
    this._devLabel.classList.toggle('game-screen__dev-toggle-label--on', on);

    if (on) {
      DevOverlay.start(this._devCanvas);
      DevOverlay.resize();
      gridEngine.republishGridState();
    } else {
      DevOverlay.stop();
    }
  }

  syncCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const game = this._gameCanvas ?? document.getElementById('game');
    if (!game) return;

    if (this._gameReparented && this._stage) {
      const rect = this._stage.getBoundingClientRect();
      game.width = Math.floor(rect.width * dpr);
      game.height = Math.floor(rect.height * dpr);
      game.style.width = `${rect.width}px`;
      game.style.height = `${rect.height}px`;
    } else {
      game.width = Math.floor(window.innerWidth * dpr);
      game.height = Math.floor(window.innerHeight * dpr);
      game.style.width = `${window.innerWidth}px`;
      game.style.height = `${window.innerHeight}px`;
    }

    if (IS_DEV && this._devModeOn) {
      DevOverlay.resize();
    }
  }

  show() {
    if (!this._root) return;
    this._ensureGameCanvasInStage();
    this._root.style.display = 'flex';
    window.addEventListener('resize', this._onResize);
    requestAnimationFrame(() => {
      this.syncCanvasSize();
    });
  }

  hide() {
    if (!this._root) return;
    if (IS_DEV && this._devModeOn) {
      this.setDevMode(false);
    }
    this._root.style.display = 'none';
    window.removeEventListener('resize', this._onResize);
  }

  /**
   * @param {unknown} gridState
   * @param {unknown} playerPos
   * @param {unknown} facingDirection
   * @param {unknown} entities
   */
  updateDevOverlay(gridState, playerPos, facingDirection, entities) {
    if (!IS_DEV) return;
    DevOverlay.update(gridState, playerPos, facingDirection, entities);
  }
}
