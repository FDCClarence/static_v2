/**
 * Stereo directional chain into Resonance Audio (grid-based 2D positions).
 */
import { parseCell } from '../engine/GridEngine.js';

const CELL_METERS = 1.5;
const RAMP_S = 0.016;

/** @param {number} a */
function normalizeAngleRad(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/**
 * @typedef {object} SpatialSourceOptions
 * @property {AudioContext} audioContext
 * @property {object} resonanceAudio
 * @property {string} cell
 * @property {AudioBuffer} soundBuffer
 * @property {boolean} [loop]
 * @property {number} [baseVolume]
 */

export class SpatialSource {
  /**
   * @param {SpatialSourceOptions} opts
   */
  constructor(opts) {
    const {
      audioContext,
      resonanceAudio,
      cell,
      soundBuffer,
      loop = false,
      baseVolume = 1,
    } = opts;

    this.audioContext = audioContext;
    this.resonanceAudio = resonanceAudio;
    this.soundBuffer = soundBuffer;
    this.loop = loop;
    this._baseVolume = baseVolume;
    /** @type {number} */
    this._userVolume = 1;

    /** @type {{ x: number; y: number }} */
    this._gridPos = parseCell(cell);

    this._splitter = new ChannelSplitterNode(audioContext, { numberOfOutputs: 2 });
    this._gainL = audioContext.createGain();
    this._gainR = audioContext.createGain();
    this._filterL = audioContext.createBiquadFilter();
    this._filterR = audioContext.createBiquadFilter();
    this._delayL = audioContext.createDelay(1);
    this._delayR = audioContext.createDelay(1);
    this._merger = new ChannelMergerNode(audioContext, { numberOfInputs: 2 });

    for (const f of [this._filterL, this._filterR]) {
      f.type = 'lowpass';
      f.frequency.value = 800;
    }
    this._delayL.delayTime.value = 0;
    this._delayR.delayTime.value = 0;

    this._splitter.connect(this._gainL, 0);
    this._splitter.connect(this._gainR, 1);
    this._gainL.connect(this._filterL);
    this._filterL.connect(this._delayL);
    this._delayL.connect(this._merger, 0, 0);
    this._gainR.connect(this._filterR);
    this._filterR.connect(this._delayR);
    this._delayR.connect(this._merger, 0, 1);

    this._resSource = resonanceAudio.createSource();
    this._merger.connect(this._resSource.input);

    /** @type {AudioBufferSourceNode | null} */
    this._bufferSource = null;
    /** @type {(() => void) | null} Fired when a non-looping buffer finishes. */
    this.onPlaybackEnded = null;

    /** @type {{ x: number; y: number }} */
    this._lastListenerGridPos = { x: 0, y: 0 };
    /** @type {number} */
    this._lastListenerHeadingDeg = 0;

    this._syncResonancePosition();
    this.updateDirectionalFilter(this._lastListenerGridPos, this._lastListenerHeadingDeg);
  }

  _syncResonancePosition() {
    const mx = this._gridPos.x * CELL_METERS;
    const mz = this._gridPos.y * CELL_METERS;
    this._resSource.setPosition(mx, 0, mz);
  }

  /**
   * @param {AudioParam} param
   * @param {number} value
   */
  _ramp(param, value) {
    const t = this.audioContext.currentTime;
    const tEnd = t + RAMP_S;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, tEnd);
  }

  /**
   * @param {{ x: number; y: number }} listenerGridPos
   * @param {number} listenerHeadingDeg
   */
  updateDirectionalFilter(listenerGridPos, listenerHeadingDeg) {
    this._lastListenerGridPos = { x: listenerGridPos.x, y: listenerGridPos.y };
    this._lastListenerHeadingDeg = listenerHeadingDeg;

    const lx = listenerGridPos.x;
    const ly = listenerGridPos.y;
    const sx = this._gridPos.x;
    const sy = this._gridPos.y;

    const sourceAngle = Math.atan2(sy - ly, sx - lx);
    const headingRad = listenerHeadingDeg * (Math.PI / 180);
    const angleTo = normalizeAngleRad(sourceAngle - headingRad);
    const cosAngle = Math.cos(angleTo);

    const vol = this._baseVolume * this._userVolume;
    const leftG = vol * (0.4 + ((cosAngle + 1) / 2) * 0.6);
    const rightG = vol * (0.4 + ((-cosAngle + 1) / 2) * 0.6);
    const cutoff = 800 + ((cosAngle + 1) / 2) * 3200;
    const delayAmt = (1 - Math.abs(cosAngle)) * 0.0006;
    const sinA = Math.sin(angleTo);
    const delayL = sinA < 0 ? delayAmt : 0;
    const delayR = sinA >= 0 ? delayAmt : 0;

    this._ramp(this._gainL.gain, leftG);
    this._ramp(this._gainR.gain, rightG);
    this._ramp(this._filterL.frequency, cutoff);
    this._ramp(this._filterR.frequency, cutoff);
    this._ramp(this._delayL.delayTime, delayL);
    this._ramp(this._delayR.delayTime, delayR);
  }

  /**
   * @param {string} cell
   */
  setPosition(cell) {
    this._gridPos = parseCell(cell);
    this._syncResonancePosition();
  }

  /**
   * @param {AudioBuffer | null} buffer
   */
  setSoundBuffer(buffer) {
    this.soundBuffer = buffer;
  }

  /** @returns {boolean} */
  get playing() {
    return this._bufferSource != null;
  }

  play() {
    this.stop();
    const src = this.audioContext.createBufferSource();
    src.buffer = this.soundBuffer;
    src.loop = this.loop;
    src.connect(this._splitter);
    src.onended = () => {
      if (this._bufferSource === src) {
        this._bufferSource = null;
        this.onPlaybackEnded?.();
      }
    };
    this._bufferSource = src;
    src.start(0);
  }

  stop() {
    if (!this._bufferSource) return;
    try {
      this._bufferSource.stop();
    } catch {
      /* already stopped */
    }
    this._bufferSource.disconnect();
    this._bufferSource = null;
  }

  /**
   * @param {number} v
   */
  setVolume(v) {
    this._userVolume = v;
    this.updateDirectionalFilter(this._lastListenerGridPos, this._lastListenerHeadingDeg);
  }
}
