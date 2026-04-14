/** Full-screen black game surface; optional dev grid overlay (dev builds only). */

import { gameEvents } from '../engine/EventEmitter.js';
import { gridEngine } from '../engine/GridEngine.js';
import * as DevOverlay from './DevOverlay.js';

const STYLE_ID = 'game-screen-styles';
const DEV_OVERRIDE =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('dev') === '1';
const IS_LOCALHOST =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
const IS_DEV = Boolean(import.meta?.env?.DEV) || DEV_OVERRIDE || IS_LOCALHOST;

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
    /** @type {HTMLDivElement | null} */
    this._compass = null;
    /** @type {SVGGElement | null} */
    this._compassNorthGroup = null;
    /** @type {SVGPolygonElement | null} */
    this._compassInnerArrow = null;
    /** @type {HTMLDivElement | null} */
    this._compassCardinal = null;
    /** @type {HTMLDivElement | null} */
    this._compassDegrees = null;

    this._devModeOn = false;
    this._gameReparented = false;

    this._onResize = this._onResize.bind(this);
    this._onDevToggle = this._onDevToggle.bind(this);
    this._onGridStateChanged = this._onGridStateChanged.bind(this);
    this._onInputTick = this._onInputTick.bind(this);

    gameEvents.on('GRID_STATE_CHANGED', this._onGridStateChanged);

    this.render();
  }

  /**
   * @param {unknown} detail
   */
  _onGridStateChanged(detail) {
    if (!detail || typeof detail !== 'object') return;
    const d = /** @type {Record<string, unknown>} */ (detail);
    const ft =
      d.forwardThreat && typeof d.forwardThreat === 'object'
        ? /** @type {{ isUnsafe?: unknown }} */ (d.forwardThreat)
        : null;
    this._setCompassForwardDanger(ft?.isUnsafe === true);
    this.updateDevOverlay(d.grid, d.playerPos, d.facingDirection, d.entities);
  }

  /**
   * @param {boolean} isDanger
   */
  _setCompassForwardDanger(isDanger) {
    this._compassInnerArrow?.classList.toggle('game-screen__compass-inner-arrow--danger', isDanger);
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

        .game-screen__compass {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 5;
          display: flex;
          flex-direction: column;
          align-items: center;
          pointer-events: none;
          color: #fff;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }

        .game-screen__compass-svg {
          width: min(100vw, 450px);
          height: min(100vw, 450px);
          display: block;
        }

        .game-screen__compass-ring {
          position: relative;
          width: min(100vw, 450px);
          height: min(100vw, 450px);
        }

        .game-screen__compass-readout {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          pointer-events: none;
        }

        .game-screen__compass-cardinal {
          margin: 0;
          font-size: clamp(50px, 10vw, 80px);
          line-height: 1;
          letter-spacing: 0.05em;
          color: #fff;
        }

        .game-screen__compass-degrees {
          margin-top: 6px;
          font-size: clamp(22px, 4vw, 28px);
          line-height: 1.2;
          color: #666;
        }

        .game-screen__compass-arrows {
          margin-top: 8px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          opacity: 0.35;
        }

        .game-screen__compass-arrow-up,
        .game-screen__compass-arrow-down {
          width: 0;
          height: 0;
          border-left: 7px solid transparent;
          border-right: 7px solid transparent;
        }

        .game-screen__compass-arrow-up {
          border-bottom: 10px solid #fff;
        }

        .game-screen__compass-arrow-down {
          border-top: 10px solid #fff;
        }

        .game-screen__compass-hint {
          margin-top: 8px;
          font-size: clamp(9px, 2vw, 11px);
          line-height: 1.2;
          color: rgba(255, 255, 255, 0.25);
          text-transform: lowercase;
        }

        .game-screen__compass-outer-arrow {
          fill: #fff;
          opacity: 0.55;
        }

        .game-screen__compass-inner-arrow {
          fill: #fff;
          opacity: 0.55;
          transition: fill 220ms ease, opacity 220ms ease;
        }

        .game-screen__compass-inner-arrow--danger {
          fill: #7f1d1d;
          opacity: 0.95;
        }
      `;
      if (IS_DEV) {
        css += `
        .game-screen--dev .game-screen__stage {
          top: 54px;
        }

        .game-screen__dev-bar {
          position: absolute;
          top: 10px;
          left: 12px;
          right: 12px;
          height: 38px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 12px;
          background: linear-gradient(180deg, rgba(24, 24, 24, 0.9), rgba(8, 8, 8, 0.86));
          box-shadow:
            0 14px 36px rgba(0, 0, 0, 0.45),
            inset 0 1px 0 rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 12px 0 14px;
          z-index: 100;
          box-sizing: border-box;
          -webkit-user-select: none;
          user-select: none;
        }

        .game-screen__dev-title {
          margin: 0;
          font-size: 10px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          color: rgba(255, 255, 255, 0.76);
          text-shadow: 0 1px 0 rgba(0, 0, 0, 0.35);
        }

        .game-screen__dev-toggle-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 2px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .game-screen__dev-toggle-label {
          font-size: 10px;
          letter-spacing: 0.08em;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          min-width: 30px;
          text-align: right;
          transition: color 160ms ease;
        }

        .game-screen__dev-toggle-label--off {
          color: #8a8a8a;
        }

        .game-screen__dev-toggle-label--on {
          color: #efefef;
        }

        .game-screen__dev-toggle {
          position: relative;
          width: 42px;
          height: 24px;
          padding: 0;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 999px;
          background: linear-gradient(180deg, #242424, #151515);
          cursor: pointer;
          flex-shrink: 0;
          box-sizing: border-box;
          transition: border-color 180ms ease, background 180ms ease;
        }

        .game-screen__dev-toggle:focus-visible {
          outline: 2px solid rgba(255, 255, 255, 0.55);
          outline-offset: 2px;
        }

        .game-screen__dev-toggle-knob {
          position: absolute;
          top: 50%;
          left: 3px;
          width: 16px;
          height: 16px;
          margin-top: -8px;
          border-radius: 50%;
          background: linear-gradient(180deg, #f6f6f6, #bcbcbc);
          box-shadow:
            0 1px 4px rgba(0, 0, 0, 0.42),
            inset 0 1px 0 rgba(255, 255, 255, 0.6);
          transition: transform 180ms ease;
          pointer-events: none;
        }

        .game-screen__dev-toggle--on .game-screen__dev-toggle-knob {
          transform: translateX(18px);
        }

        .game-screen__dev-toggle--on {
          border-color: rgba(255, 255, 255, 0.34);
          background: linear-gradient(180deg, #353535, #1f1f1f);
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
      <div class="game-screen__compass" aria-hidden="true">
        <div class="game-screen__compass-ring">
          <svg class="game-screen__compass-svg" viewBox="0 0 260 260" width="min(100vw, 450px)" height="min(100vw, 450px)">
            <circle cx="130" cy="130" r="74" fill="none" stroke="#333" stroke-width="2"></circle>
            <circle cx="130" cy="130" r="74" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="2 6"></circle>
            <polygon
              class="game-screen__compass-inner-arrow"
              points="130,66 142,90 130,84 118,90"
            ></polygon>
            <g id="compass-north-group">
              <polygon
                class="game-screen__compass-outer-arrow"
                points="130,16 137,36 130,32 123,36"
              ></polygon>
            </g>
          </svg>
          <div class="game-screen__compass-readout">
            <div class="game-screen__compass-cardinal">N</div>
            <div class="game-screen__compass-degrees">0°</div>
          </div>
        </div>
        <div class="game-screen__compass-arrows" aria-hidden="true">
          <div class="game-screen__compass-arrow-up"></div>
          <div class="game-screen__compass-arrow-down"></div>
        </div>
        <div class="game-screen__compass-hint">swipe up or down to move</div>
      </div>
    `;

    this._stage = root.querySelector('.game-screen__stage');
    this._devCanvas = IS_DEV ? root.querySelector('#dev-canvas') : null;
    this._compass = root.querySelector('.game-screen__compass');
    this._compassNorthGroup = root.querySelector('#compass-north-group');
    this._compassInnerArrow = root.querySelector('.game-screen__compass-inner-arrow');
    this._compassCardinal = root.querySelector('.game-screen__compass-cardinal');
    this._compassDegrees = root.querySelector('.game-screen__compass-degrees');

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

  /**
   * Smoothed game heading from {@link gameEvents} `INPUT_TICK` (same as gyro + dev A/D in InputManager).
   * @param {number} headingDeg
   */
  _updateCompassFromHeading(headingDeg) {
    if (!Number.isFinite(headingDeg)) return;
    const h = ((headingDeg % 360) + 360) % 360;
    // Game heading from InputManager is already 0=N, 90=E (clockwise). Do not use (360 - h); that
    // matched raw device `alpha` in the old listener and inverts the dial vs A/D and grid facing.
    const northDeg = h;
    const roundedDeg = Math.round(h);

    let cardinal = 'N';
    if (h >= 337.5 || h < 22.5) {
      cardinal = 'N';
    } else if (h < 67.5) {
      cardinal = 'NE';
    } else if (h < 112.5) {
      cardinal = 'E';
    } else if (h < 157.5) {
      cardinal = 'SE';
    } else if (h < 202.5) {
      cardinal = 'S';
    } else if (h < 247.5) {
      cardinal = 'SW';
    } else if (h < 292.5) {
      cardinal = 'W';
    } else {
      cardinal = 'NW';
    }

    this._compassNorthGroup?.setAttribute('transform', `rotate(${northDeg}, 130, 130)`);
    if (this._compassCardinal) this._compassCardinal.textContent = cardinal;
    if (this._compassDegrees) this._compassDegrees.textContent = `${roundedDeg}°`;
  }

  /**
   * @param {unknown} detail
   */
  _onInputTick(detail) {
    if (!detail || typeof detail !== 'object') return;
    const heading = /** @type {{ heading?: unknown }} */ (detail).heading;
    if (typeof heading !== 'number' || !Number.isFinite(heading)) return;
    this._updateCompassFromHeading(heading);
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
    if (this._compass) this._compass.style.display = on ? 'none' : 'flex';

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
    gameEvents.on('INPUT_TICK', this._onInputTick);
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
    gameEvents.off('INPUT_TICK', this._onInputTick);
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
