/** Gyro, swipe detection, 8-way direction */
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

/**
 * Unit forward on XZ grid from compass-style degrees (0 = N, 90 = E).
 * @param {number} degrees
 */
function forwardFromDegrees(degrees) {
  const r = (degrees * Math.PI) / 180;
  return { x: Math.sin(r), z: Math.cos(r) };
}

export class InputManager {
  /**
   * @param {import('./EventEmitter.js').EventEmitter} [emitter]
   */
  constructor(emitter = gameEvents) {
    this.emitter = emitter;

    /** @type {boolean} */
    this._needsOrientationPermission = false;
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
  }

  init() {
    this._needsOrientationPermission =
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';
    this._needsMotionPermission =
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';

    window.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    window.addEventListener('pointerup', this._onPointerUp, { passive: true });
    window.addEventListener('pointercancel', this._onPointerCancel, { passive: true });

    if (!this._needsOrientationPermission && !this._needsMotionPermission) {
      this._attachSensors();
    }
  }

  /**
   * Request sensor permission (iOS 13+). Must run from a user gesture.
   * @returns {Promise<'granted' | 'denied' | string>}
   */
  async requestPermission() {
    if (this._sensorsAttached) return 'granted';

    try {
      if (this._needsOrientationPermission) {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return r;
      }
      if (this._needsMotionPermission) {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') return r;
      }
      this._attachSensors();
      return 'granted';
    } catch {
      if (!this._needsOrientationPermission && !this._needsMotionPermission) {
        this._attachSensors();
      }
      return 'denied';
    }
  }

  /** @returns {number} Raw heading in degrees (0–360). */
  get rawHeading() {
    return normalizeDeg(this._rawHeading);
  }

  /** @returns {string} Snapped 8-way direction label. */
  get snappedDirection() {
    return this._snappedDirection;
  }

  /** @returns {{ x: number; z: number }} Unit forward on the XZ grid for the snapped direction. */
  get forwardVector() {
    const idx = DIRECTION_ORDER.indexOf(this._snappedDirection);
    const deg = idx >= 0 ? idx * 45 : 0;
    return forwardFromDegrees(deg);
  }

  _attachSensors() {
    if (this._sensorsAttached) return;
    this._sensorsAttached = true;
    window.addEventListener('deviceorientation', this._onDeviceOrientation, true);
    window.addEventListener('devicemotion', this._onDeviceMotion, true);
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
      this.emitter.emit('FACING_CHANGED', { direction: label });
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
      this.emitter.emit('MOVE_INTENT', { direction: this._snappedDirection });
    }
  }

  /** @param {PointerEvent} e */
  _onPointerCancel(e) {
    if (this._activePointer && e.pointerId === this._activePointer.id) {
      this._activePointer = null;
    }
  }
}
