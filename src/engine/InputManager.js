/**
 * 2D grid input: compass heading on one axis, swipe-up to move.
 * Grid: x right, y down. Audio uses heading angle directly (no forward vector).
 */
import { gameEvents } from './EventEmitter.js';

const EMA_FACTOR = 0.15;
const SWIPE_MIN_UP_PX = 40;
const SWIPE_MAX_HORIZONTAL_PX = 80;
const SWIPE_MAX_MS = 400;
const ORIENTATION_MIN_HZ = 30;
const ORIENTATION_MAX_INTERVAL_MS = 1000 / ORIENTATION_MIN_HZ;
/** Min samples before treating average interval as stable. */
const ORIENTATION_RATE_SAMPLES = 4;

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
 * @param {number} deg
 */
function snapHeading(deg) {
  const a = normalizeDeg(deg);
  let snapped = Math.round(a / 45) * 45;
  if (snapped === 360) snapped = 0;
  const idx = Math.round(snapped / 45) % 8;
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

    /** Latest sensor heading before smoothing (deg, 0–360). */
    this._rawHeading = 0;
    /** Smoothed heading (deg, 0–360). */
    this._smoothedHeading = 0;
    /** @type {string} */
    this._snappedDirection = 'N';

    /** Circular EMA state (unit circle projection of heading). */
    this._smoothSin = null;
    this._smoothCos = null;

    /** @type {number[]} */
    this._orientationIntervals = [];
    /** @type {number | null} */
    this._lastOrientationTime = null;
    /** @type {boolean} */
    this._useMotionIntegration = false;

    /** @type {number | null} */
    this._lastMotionTime = null;

    /** @type {{ x: number; y: number; t: number; id: number } | null} */
    this._activePointer = null;

    this._onDeviceOrientation = this._onDeviceOrientation.bind(this);
    this._onDeviceMotion = this._onDeviceMotion.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onInputRaf = this._onInputRaf.bind(this);

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

    // DeviceOrientation permission is requested in PermissionScreen; listeners attach here.
    this._attachSensors();
    this._startInputTick();
  }

  /**
   * Request DeviceMotion permission on iOS 13+ (for low-rate orientation fallback).
   * DeviceOrientation is already requested in PermissionScreen.
   * @returns {Promise<'granted' | 'denied' | string>}
   */
  async requestPermission() {
    if (!this._needsMotionPermission) return 'granted';
    try {
      return await DeviceMotionEvent.requestPermission();
    } catch {
      return 'denied';
    }
  }

  /** @returns {number} Raw heading in degrees (0–360). */
  get heading() {
    return normalizeDeg(this._rawHeading);
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
    window.addEventListener('devicemotion', this._onDeviceMotion, true);
  }

  _startInputTick() {
    if (this._inputRafId != null) return;
    this._inputRafId = requestAnimationFrame(this._onInputRaf);
  }

  _onInputRaf() {
    this._inputRafId = requestAnimationFrame(this._onInputRaf);
    this.emitter.emit('INPUT_TICK', { heading: normalizeDeg(this._smoothedHeading) });
  }

  _recordOrientationInterval() {
    const now = performance.now();
    if (this._lastOrientationTime != null) {
      const dt = now - this._lastOrientationTime;
      this._orientationIntervals.push(dt);
      if (this._orientationIntervals.length > 16) this._orientationIntervals.shift();
      if (this._orientationIntervals.length >= ORIENTATION_RATE_SAMPLES) {
        const sum = this._orientationIntervals.reduce((a, b) => a + b, 0);
        const avg = sum / this._orientationIntervals.length;
        if (avg > ORIENTATION_MAX_INTERVAL_MS) {
          if (!this._useMotionIntegration) {
            this._useMotionIntegration = true;
            this._rawHeading = this._smoothedHeading;
            this._lastMotionTime = null;
          }
        } else if (avg < ORIENTATION_MAX_INTERVAL_MS * 0.85 && this._useMotionIntegration) {
          this._useMotionIntegration = false;
          this._lastMotionTime = null;
        }
      }
    }
    this._lastOrientationTime = now;
  }

  /** @param {DeviceOrientationEvent} e */
  _onDeviceOrientation(e) {
    if (!this._sensorsAttached) return;
    this._recordOrientationInterval();

    if (this._useMotionIntegration) return;

    if (e.alpha == null || Number.isNaN(e.alpha)) return;

    this._rawHeading = normalizeDeg(e.alpha);
    this._applySmoothing(this._rawHeading);
  }

  /** @param {DeviceMotionEvent} e */
  _onDeviceMotion(e) {
    if (!this._sensorsAttached || !this._useMotionIntegration) return;

    const t =
      typeof e.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : performance.now();
    const rate = e.rotationRate?.alpha;
    if (rate == null || Number.isNaN(rate)) return;

    if (this._lastMotionTime == null) {
      this._lastMotionTime = t;
      return;
    }

    const dt = (t - this._lastMotionTime) / 1000;
    this._lastMotionTime = t;
    if (dt <= 0 || dt > 0.5) return;

    this._rawHeading = normalizeDeg(this._rawHeading + rate * dt);
    this._applySmoothing(this._rawHeading);
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
    const dx = e.clientX - start.x;
    const dt = performance.now() - start.t;

    if (
      verticalUp > SWIPE_MIN_UP_PX &&
      Math.abs(dx) < SWIPE_MAX_HORIZONTAL_PX &&
      dt < SWIPE_MAX_MS
    ) {
      this.emitter.emit('MOVE_INTENT', { facingDirection: this._snappedDirection });
    }
  }

  /** @param {PointerEvent} e */
  _onPointerCancel(e) {
    if (this._activePointer && e.pointerId === this._activePointer.id) {
      this._activePointer = null;
    }
  }
}
