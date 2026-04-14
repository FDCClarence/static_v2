const STYLE_ID = 'game-over-screen-styles';

export class GameOverScreen {
  constructor() {
    /** @type {(() => void) | null} */
    this.onBackToLanding = null;
    /** @type {HTMLDivElement | null} */
    this._root = null;
    /** @type {HTMLHeadingElement | null} */
    this._title = null;
    /** @type {HTMLParagraphElement | null} */
    this._subtitle = null;
    this.render();
  }

  render() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        .game-over-screen {
          position: fixed;
          inset: 0;
          z-index: 2;
          display: none;
          background: #000;
          color: #fff;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 24px;
        }

        .game-over-screen__inner {
          width: 100%;
          max-width: min(100%, 340px);
        }

        .game-over-screen__title {
          margin: 0;
          font-size: 42px;
          letter-spacing: 0.12em;
        }

        .game-over-screen__subtitle {
          margin: 14px 0 0;
          color: #888;
          font-size: 13px;
        }

        .game-over-screen__button {
          width: 100%;
          height: 48px;
          margin: 28px 0 0;
          border: 1px solid #fff;
          background: transparent;
          color: #fff;
          font: inherit;
          letter-spacing: 0.2em;
          cursor: pointer;
        }

        .game-over-screen__button:hover,
        .game-over-screen__button:focus-visible {
          background: #fff;
          color: #000;
        }
      `;
      document.head.appendChild(style);
    }

    if (this._root) return;

    const root = document.createElement('div');
    root.className = 'game-over-screen';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="game-over-screen__inner">
        <h2 class="game-over-screen__title">GAME OVER</h2>
        <p class="game-over-screen__subtitle">You escaped every level.</p>
        <button type="button" class="game-over-screen__button">BACK TO LANDING</button>
      </div>
    `;

    this._title = root.querySelector('.game-over-screen__title');
    this._subtitle = root.querySelector('.game-over-screen__subtitle');
    const button = root.querySelector('.game-over-screen__button');
    button?.addEventListener('click', () => {
      this.onBackToLanding?.();
    });

    this._root = root;
    document.body.appendChild(root);
    this.hide();
  }

  /**
   * @param {'escaped' | 'died'} outcome
   */
  show(outcome = 'escaped') {
    if (!this._root) return;
    if (this._title) {
      this._title.textContent = outcome === 'died' ? 'YOU DIED' : 'YOU ESCAPED';
    }
    if (this._subtitle) {
      this._subtitle.textContent =
        outcome === 'died' ? 'Your run ended before the exit.' : 'You escaped every level.';
    }
    this._root.style.display = 'flex';
    this._root.setAttribute('aria-hidden', 'false');
  }

  hide() {
    if (!this._root) return;
    this._root.style.display = 'none';
    this._root.setAttribute('aria-hidden', 'true');
  }
}
