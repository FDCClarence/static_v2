/** First screen: audio unlock + DeviceOrientation permission (one tap). */

const STYLE_ID = 'permission-screen-styles';

export class PermissionScreen {
  constructor() {
    /** @type {(() => void) | null} */
    this.onGranted = null;

    this._injectStyles();
    this._root = this._buildRoot();
    document.body.appendChild(this._root);
    this.hide();
  }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes permission-screen-border-pulse {
        0%, 100% { border-color: rgba(68, 68, 68, 0.4); }
        50% { border-color: rgba(68, 68, 68, 1); }
      }
      .permission-screen__btn {
        animation: permission-screen-border-pulse 2s ease-in-out infinite;
      }
    `;
    document.head.appendChild(style);
  }

  _buildRoot() {
    const root = document.createElement('div');
    root.className = 'permission-screen';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = [
      'display:none',
      'position:fixed',
      'inset:0',
      'z-index:2',
      'box-sizing:border-box',
      'margin:0',
      'padding:0',
      'background:#000',
      'align-items:center',
      'justify-content:center',
      'flex-direction:column',
      'font-family:system-ui,sans-serif',
      'text-align:center',
      '-webkit-user-select:none',
      'user-select:none',
      'touch-action:manipulation',
    ].join(';');

    const stack = document.createElement('div');
    stack.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;';

    const iconWrap = document.createElement('div');
    iconWrap.style.cssText = 'margin-bottom:16px;color:#fff;';
    iconWrap.innerHTML = `
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M8 22v8a3 3 0 0 0 3 3h1a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3H8z" stroke="currentColor" stroke-width="1.5" fill="none"/>
        <path d="M32 22v8a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3h4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
        <path d="M11 22V14a9 9 0 0 1 18 0v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      </svg>
    `;

    const title = document.createElement('p');
    title.textContent = 'This game requires headphones.';
    title.style.cssText =
      'margin:0;color:#fff;font-size:18px;font-weight:400;line-height:1.35;';

    const sub = document.createElement('p');
    sub.textContent = 'Sound and motion access needed.';
    sub.style.cssText = 'margin:12px 0 0;color:#888;font-size:14px;line-height:1.35;';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'permission-screen__btn';
    btn.textContent = 'ALLOW & CONTINUE';
    btn.style.cssText = [
      'margin-top:32px',
      'padding:14px 32px',
      'border:1px solid #444',
      'background:transparent',
      'color:#fff',
      'font:inherit',
      'font-size:14px',
      'letter-spacing:0.15em',
      'cursor:pointer',
      'text-transform:none',
    ].join(';');

    this._button = btn;
    btn.addEventListener('click', () => {
      void this._onAllow();
    });

    stack.appendChild(iconWrap);
    stack.appendChild(title);
    stack.appendChild(sub);
    stack.appendChild(btn);
    root.appendChild(stack);
    return root;
  }

  async _onAllow() {
    this._button.disabled = true;

    try {
      const ctx = new AudioContext();
      await ctx.suspend();
    } catch {
      /* still continue */
    }

    let motionDenied = false;
    try {
      if (
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function'
      ) {
        // true = include magnetometer; needed for compass / webkitCompassHeading (MDN).
        let result;
        try {
          result = await DeviceOrientationEvent.requestPermission(true);
        } catch {
          result = await DeviceOrientationEvent.requestPermission();
        }
        if (result !== 'granted') motionDenied = true;
      }
    } catch {
      /* no permission string; still continue */
    }

    try {
      if (
        typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function'
      ) {
        const result = await DeviceMotionEvent.requestPermission();
        if (result !== 'granted') motionDenied = true;
      }
    } catch {
      /* still continue */
    }

    if (motionDenied) {
      this._button.textContent = 'Motion access denied — some features unavailable';
    }

    this.onGranted?.();
    this._button.disabled = false;
  }

  show() {
    this._root.style.display = 'flex';
    this._root.setAttribute('aria-hidden', 'false');
  }

  hide() {
    this._root.style.display = 'none';
    this._root.setAttribute('aria-hidden', 'true');
  }
}
