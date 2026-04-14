/**
 * 2D grid input: compass heading on one axis, swipe-up forward, swipe-down backward.
 * Grid: x right, y down. Audio uses heading angle directly (no forward vector).
 */
import { gameEvents } from './EventEmitter.js';

const DEV_OVERRIDE =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('dev') === '1';
const IS_LOCALHOST =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
const IS_DEV_BUILD = Boolean(import.meta?.env?.DEV) || DEV_OVERRIDE || IS_LOCALHOST;

const EMA_FACTOR = 0.15;
/** Degrees shifted from cardinals toward diagonals at snap boundaries (smoother diagonal intent). */
const DIAG_SNAP_BIAS_DEG = 7;
const SWIPE_MIN_UP_PX = 40;
const SWIPE_MIN_DOWN_PX = 40;
const SWIPE_MAX_HORIZONTAL_PX = 80;
const SWIPE_MAX_MS = 400;
const DIRECTION_ORDER = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

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

/** @param {number} deg */
function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * Nearest 8-way compass label and snapped angle (deg).
 * Diagonals use slightly wider sectors so near-diagonal headings still count as diagonal (pairs with grid slide).
 * @param {number} deg
 */
function snapHeading(deg) {
  const a = normalizeDeg(deg);
  const d = DIAG_SNAP_BIAS_DEG;
  const b = [22.5 - d, 67.5 + d, 112.5 - d, 157.5 + d, 202.5 - d, 247.5 + d, 292.5 - d, 337.5 + d];
  let idx = 0;
  if (a >= b[7] || a < b[0]) {
    idx = 0;
  } else {
    for (let i = 0; i < 7; i++) {
      if (a >= b[i] && a < b[i + 1]) {
        idx = i + 1;
        break;
      }
    }
  }
  let snapped = idx * 45;
  if (snapped === 360) snapped = 0;
  return { degrees: snapped, label: DIRECTION_ORDER[idx] };
}

export class InputManager {
  /**
   * @param {import('./EventEmitter.js').EventEmitter} [emitter]
   */
  constructor(emitter = gameEvents) {
    this.emitter = emitter;

    /** @type {boolean} */
    this._needsMotionPermission = false;
    /** @type {boolean} */
    this._sensorsAttached = false;
    /**
     * iOS 13+: orientation listeners must be registered after permission; registering in init() can receive no data.
     * @type {boolean}
     */
    this._deferSensorAttachUntilGesture = false;

    /** Latest sensor heading before smoothing (deg, 0–360). */
    this._rawHeading = 0;
    /** Smoothed heading (deg, 0–360). */
    this._smoothedHeading = 0;
    /** @type {string} */
    this._snappedDirection = 'N';
    /** @type {number | null} Sensor heading captured as "north" reference for current level. */
    this._headingNorthReference = null;

    /** Circular EMA state (unit circle projection of heading). */
    this._smoothSin = null;
    this._smoothCos = null;

    /** @type {{ x: number; y: number; t: number; id: number } | null} */
    this._activePointer = null;

    this._onDeviceOrientation = this._onDeviceOrientation.bind(this);
    this._onDeviceOrientationAbsolute = this._onDeviceOrientationAbsolute.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onInputRaf = this._onInputRaf.bind(this);
    this._onDevHeadingKey = this._onDevHeadingKey.bind(this);

    /** @type {number | null} */
    this._inputRafId = null;
  }

  init() {
    this._needsMotionPermission =
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';

    window.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    window.addEventListener('pointerup', this._onPointerUp, { passive: true });
    window.addEventListener('pointercancel', this._onPointerCancel, { passive: true });

    // iOS: listeners after PermissionScreen grant via attachSensorsAfterUserGesture() in main.js.
    this._deferSensorAttachUntilGesture =
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';
    if (!this._deferSensorAttachUntilGesture) {
      this._attachSensors();
    }
    this._startInputTick();

    if (IS_DEV_BUILD) {
      window.addEventListener('keydown', this._onDevHeadingKey);
    }
  }

  /**
   * Desktop / no-gyro: nudge compass heading (dev builds only).
   * @param {KeyboardEvent} e
   */
  _onDevHeadingKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t instanceof HTMLElement) {
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
    }
    const key = e.key.toLowerCase();
    if (key === 'w') {
      e.preventDefault();
      this.emitter.emit('MOVE_INTENT', { facingDirection: this._snappedDirection });
      return;
    }
    if (key === 's') {
      e.preventDefault();
      this.emitter.emit('MOVE_INTENT', {
        facingDirection: this._snappedDirection,
        moveMode: 'backward',
      });
      return;
    }
    let delta = 0;
    if (e.key === 'ArrowLeft' || e.key === ',' || key === 'a') delta = -15;
    else if (e.key === 'ArrowRight' || e.key === '.' || key === 'd') delta = 15;
    else return;
    e.preventDefault();
    this._rawHeading = normalizeDeg(this._rawHeading + delta);
    this._applySmoothing(this._rawHeading);
  }

  /**
   * Request DeviceMotion permission on iOS 13+ (for low-rate orientation fallback).
   * DeviceOrientation is already requested in PermissionScreen.
   * @returns {Promise<'granted' | 'denied' | string>}
   */
  async requestPermission() {
    if (!this._needsMotionPermission) return 'granted';
    try {
      const result = await DeviceMotionEvent.requestPermission();
      if (result === 'granted') this.attachSensorsAfterUserGesture();
      return result;
    } catch {
      return 'denied';
    }
  }

  /**
   * Call after DeviceOrientation permission was granted (PermissionScreen) or motion granted on iOS.
   * Safe to call multiple times; no-op when sensors already attached.
   */
  attachSensorsAfterUserGesture() {
    this._attachSensors();
  }

  /**
   * Recalibrate heading so current device orientation is treated as north.
   * Intended to be called at level start.
   */
  calibrateNorthForLevelStart() {
    this._headingNorthReference = null;
    this._rawHeading = 0;
    this._smoothedHeading = 0;
    this._smoothSin = 0;
    this._smoothCos = 1;
    if (this._snappedDirection !== 'N') {
      this._snappedDirection = 'N';
      this.emitter.emit('FACING_CHANGED', { facingDirection: 'N' });
    }
  }

  /** @returns {number} Raw heading in degrees (0–360). */
  get heading() {
    return normalizeDeg(this._rawHeading);
  }

  /**
   * EMA-smoothed heading (0–360), same value as {@link gameEvents} INPUT_TICK `heading`.
   * Use for spatial audio with Resonance so listener orientation matches per-source math.
   */
  get smoothedHeading() {
    return normalizeDeg(this._smoothedHeading);
  }

  /** @returns {number} Raw heading in degrees (0–360). */
  get rawHeading() {
    return this.heading;
  }

  /** @returns {string} Snapped 8-way direction label. */
  get facingDirection() {
    return this._snappedDirection;
  }

  /** @returns {string} Snapped 8-way direction label. */
  get snappedDirection() {
    return this._snappedDirection;
  }

  /**
   * One grid step for current facing (x right, y down).
   * @returns {{ dx: number; dy: number }}
   */
  get movementDelta() {
    return DIRECTION_DELTA[this._snappedDirection] ?? DIRECTION_DELTA.N;
  }

  _attachSensors() {
    if (this._sensorsAttached) return;
    this._sensorsAttached = true;
    window.addEventListener('deviceorientation', this._onDeviceOrientation, true);
    // Do not gate on `in window` — some Chromium builds support the event without the handler property.
    window.addEventListener(
      'deviceorientationabsolute',
      this._onDeviceOrientationAbsolute,
      true,
    );
  }

  _startInputTick() {
    if (this._inputRafId != null) return;
    this._inputRafId = requestAnimationFrame(this._onInputRaf);
  }

  _onInputRaf() {
    this._inputRafId = requestAnimationFrame(this._onInputRaf);
    this.emitter.emit('INPUT_TICK', { heading: normalizeDeg(this._smoothedHeading) });
  }

  /**
   * @param {DeviceOrientationEvent} e
   * @returns {number | null}
   */
  _headingFromOrientationEvent(e) {
    const oe = /** @type {DeviceOrientationEvent & { webkitCompassHeading?: number }} */ (e);
    if (typeof oe.webkitCompassHeading === 'number' && Number.isFinite(oe.webkitCompassHeading)) {
      return normalizeDeg(oe.webkitCompassHeading);
    }
    if (e.alpha != null && Number.isFinite(e.alpha)) {
      return normalizeDeg(e.alpha);
    }
    return null;
  }

  /**
   * Apply compass/yaw from an orientation event. Always preferred over motion integration
   * when any heading can be read (fixes iOS + browsers that omit webkitCompassHeading).
   * @param {DeviceOrientationEvent} e
   */
  _applyOrientationHeading(e) {
    let headingDeg = this._headingFromOrientationEvent(e);
    if (headingDeg == null) return;

    if (this._headingNorthReference == null) {
      this._headingNorthReference = headingDeg;
    }
    headingDeg = normalizeDeg(headingDeg - this._headingNorthReference);

    this._rawHeading = headingDeg;
    this._applySmoothing(this._rawHeading);
  }

  /** @param {DeviceOrientationEvent} e */
  _onDeviceOrientation(e) {
    if (!this._sensorsAttached) return;
    this._applyOrientationHeading(e);
  }

  /** @param {DeviceOrientationEvent} e */
  _onDeviceOrientationAbsolute(e) {
    if (!this._sensorsAttached) return;
    this._applyOrientationHeading(e);
  }

  /** @param {number} rawDeg */
  _applySmoothing(rawDeg) {
    const rad = (normalizeDeg(rawDeg) * Math.PI) / 180;
    const rx = Math.sin(rad);
    const rz = Math.cos(rad);

    if (this._smoothSin == null || this._smoothCos == null) {
      this._smoothSin = rx;
      this._smoothCos = rz;
    } else {
      this._smoothSin = EMA_FACTOR * rx + (1 - EMA_FACTOR) * this._smoothSin;
      this._smoothCos = EMA_FACTOR * rz + (1 - EMA_FACTOR) * this._smoothCos;
    }

    let deg = (Math.atan2(this._smoothSin, this._smoothCos) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    this._smoothedHeading = deg;

    const { label } = snapHeading(deg);
    if (label !== this._snappedDirection) {
      this._snappedDirection = label;
      this.emitter.emit('FACING_CHANGED', { facingDirection: label });
    }
  }

  /** @param {PointerEvent} e */
  _onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this._activePointer) return;
    this._activePointer = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      id: e.pointerId,
    };
  }

  /** @param {PointerEvent} e */
  _onPointerUp(e) {
    if (!this._activePointer || e.pointerId !== this._activePointer.id) return;

    const start = this._activePointer;
    this._activePointer = null;

    const verticalUp = start.y - e.clientY;
    const verticalDown = e.clientY - start.y;
    const dx = e.clientX - start.x;
    const dt = performance.now() - start.t;

    if (
      verticalUp > SWIPE_MIN_UP_PX &&
      Math.abs(dx) < SWIPE_MAX_HORIZONTAL_PX &&
      dt < SWIPE_MAX_MS
    ) {
      this.emitter.emit('MOVE_INTENT', { facingDirection: this._snappedDirection });
      return;
    }

    if (
      verticalDown > SWIPE_MIN_DOWN_PX &&
      Math.abs(dx) < SWIPE_MAX_HORIZONTAL_PX &&
      dt < SWIPE_MAX_MS
    ) {
      this.emitter.emit('MOVE_INTENT', {
        facingDirection: this._snappedDirection,
        moveMode: 'backward',
      });
    }
  }

  /** @param {PointerEvent} e */
  _onPointerCancel(e) {
    if (this._activePointer && e.pointerId === this._activePointer.id) {
      this._activePointer = null;
    }
  }
}
