/** Title screen after permissions; dark, minimal. */

const STYLE_ID = 'landing-page-styles';

export class LandingPage {
  constructor() {
    /** @type {(() => void) | null} */
    this.onStart = null;

    this._root = null;
    this.render();
  }

  render() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        .landing-page {
          position: fixed;
          inset: 0;
          z-index: 1;
          display: none;
          box-sizing: border-box;
          margin: 0;
          padding: 24px;
          background: #000;
          color: #fff;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          text-align: center;
          -webkit-user-select: none;
          user-select: none;
          touch-action: manipulation;
        }

        .landing-page__inner {
          display: flex;
          flex-direction: column;
          align-items: center;
          width: 100%;
          max-width: min(100%, 320px);
        }

        .landing-page__title {
          margin: 0;
          font-size: 42px;
          font-weight: 400;
          color: #f0f0f0;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          line-height: 1.15;
          opacity: 0;
          transition: opacity 800ms ease;
        }

        .landing-page__tagline {
          margin: 16px 0 0;
          font-size: 13px;
          font-style: italic;
          color: #555;
          line-height: 1.5;
          opacity: 0;
          transition: opacity 600ms ease;
        }

        .landing-page__divider {
          width: 100%;
          max-width: 280px;
          height: 0;
          margin: 40px 0;
          border: 0;
          border-top: 1px solid #222;
          opacity: 0;
          transition: opacity 600ms ease;
        }

        .landing-page__controls {
          width: 100%;
          max-width: 280px;
          opacity: 0;
          transition: opacity 600ms ease;
        }

        .landing-page__controls-label {
          margin: 0 0 8px;
          font-size: 11px;
          font-weight: 400;
          color: #444;
          letter-spacing: 0.2em;
        }

        .landing-page__controls-body {
          margin: 0;
          font-size: 13px;
          line-height: 2;
          color: #888;
        }

        .landing-page__controls-body p {
          margin: 0;
        }

        .landing-page__start {
          display: block;
          width: 100%;
          max-width: 280px;
          height: 48px;
          margin: 40px 0 0;
          padding: 0;
          box-sizing: border-box;
          border: 1px solid #fff;
          background: transparent;
          color: #fff;
          font: inherit;
          font-size: 13px;
          letter-spacing: 0.3em;
          cursor: pointer;
          opacity: 0;
          transition:
            opacity 600ms ease,
            background-color 200ms ease,
            color 200ms ease;
        }

        .landing-page__start:hover,
        .landing-page__start:focus-visible {
          background: #fff;
          color: #000;
        }

        .landing-page__start:active {
          background: #fff;
          color: #000;
        }

        .landing-page__footer-spacer {
          height: 40px;
          flex-shrink: 0;
        }

        .landing-page--visible .landing-page__title {
          opacity: 1;
          transition-delay: 0ms;
        }

        .landing-page--visible .landing-page__tagline {
          opacity: 1;
          transition-delay: 200ms;
        }

        .landing-page--visible .landing-page__divider {
          opacity: 1;
          transition-delay: 400ms;
        }

        .landing-page--visible .landing-page__controls {
          opacity: 1;
          transition-delay: 400ms;
        }

        .landing-page--visible .landing-page__start {
          opacity: 1;
          transition-delay: 600ms;
        }
      `;
      document.head.appendChild(style);
    }

    if (this._root) return;

    const root = document.createElement('div');
    root.className = 'landing-page';
    root.setAttribute('aria-hidden', 'true');

    root.innerHTML = `
      <div class="landing-page__inner">
        <h1 class="landing-page__title">you are blind and likely bald. they shaved your head brhhhh &#9996; &#128557; &#129344;</h1>
        <p class="landing-page__tagline">monkey no eye &#129318; &#128065;. monkey only ear &#128066;</p>
        <hr class="landing-page__divider" aria-hidden="true" />
        <div class="landing-page__controls">
          <p class="landing-page__controls-label">HOW TO PLAY</p>
          <div class="landing-page__controls-body">
            <p>Rotate your phone to face a direction</p>
            <p>Swipe up to move one step</p>
            <p>Use headphones</p>
          </div>
        </div>
        <button type="button" class="landing-page__start">BEGIN</button>
        <div class="landing-page__footer-spacer" aria-hidden="true"></div>
      </div>
    `;

    const btn = root.querySelector('.landing-page__start');
    btn?.addEventListener('click', () => {
      this.onStart?.();
    });

    this._root = root;
    document.body.appendChild(root);
    this.hide();
  }

  show() {
    if (!this._root) return;
    this._root.style.display = 'flex';
    this._root.setAttribute('aria-hidden', 'false');
    this._root.classList.remove('landing-page--visible');

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._root?.classList.add('landing-page--visible');
      });
    });
  }

  hide() {
    if (!this._root) return;
    this._root.classList.remove('landing-page--visible');
    this._root.style.display = 'none';
    this._root.setAttribute('aria-hidden', 'true');
  }
}
