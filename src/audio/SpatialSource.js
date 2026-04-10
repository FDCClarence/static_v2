/**
 * Stereo directional chain into Resonance Audio (grid-based 2D positions).
 */
import { parseCell } from '../engine/GridEngine.js';

const CELL_METERS = 1.5;
const RAMP_S = 0.016;
const DEG_TO_RAD = Math.PI / 180;
const MAX_ITD_S = 0.00065;
const MIN_DISTANCE_ATTEN = 0.08;

/** @param {number} v @param {number} min @param {number} max */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** @param {number} deg */
function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
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

    this._preSplitMerger = audioContext.createChannelMerger(2);
    this._splitter = audioContext.createChannelSplitter(2);
    this._gainL = audioContext.createGain();
    this._gainR = audioContext.createGain();
    this._filterL = audioContext.createBiquadFilter();
    this._filterR = audioContext.createBiquadFilter();
    this._delayL = audioContext.createDelay(1);
    this._delayR = audioContext.createDelay(1);
    this._merger = audioContext.createChannelMerger(2);

    for (const f of [this._filterL, this._filterR]) {
      f.type = 'lowpass';
      f.frequency.value = 800;
    }
    this._delayL.delayTime.value = 0;
    this._delayR.delayTime.value = 0;

    this._preSplitMerger.connect(this._splitter);
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
    /** @type {(() => void) | null} Cleanup for {@link attachStream} (stop nodes, disconnect). */
    this._streamDispose = null;
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
    const vol = this._baseVolume * this._userVolume;

    const dx = this._gridPos.x - listenerGridPos.x;
    const dy = this._gridPos.y - listenerGridPos.y;
    const distCells = Math.hypot(dx, dy);
    // Explicit XY-grid falloff so loudness maps to tile distance.
    const distanceAtten = Math.max(MIN_DISTANCE_ATTEN, 1 / (1 + distCells * distCells * 0.45));

    // 0deg means "in front of listener", +90deg means "to the right".
    const bearingDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const relDeg = normalizeDeg(bearingDeg - listenerHeadingDeg);
    const signedRelDeg = relDeg > 180 ? relDeg - 360 : relDeg;
    const relRad = signedRelDeg * DEG_TO_RAD;

    // Stronger L/R cues at distance make gyro navigation easier without UI.
    const width = clamp(0.28 + distCells * 0.18, 0.28, 1);
    const pan = clamp(Math.sin(relRad) * width, -1, 1);
    const absPan = Math.abs(pan);
    const frontness = Math.cos(relRad); // >0 front hemisphere, <0 behind
    const behindMix = clamp((-frontness + 1) * 0.5, 0, 1);

    const nearEar = 1 + absPan * 0.28;
    const farEar = 1 - absPan * 0.55;
    const leftG = vol * distanceAtten * (pan >= 0 ? farEar : nearEar);
    const rightG = vol * distanceAtten * (pan >= 0 ? nearEar : farEar);

    // Tiny interaural delay helps source direction "snap" while rotating.
    const delayL = pan > 0 ? pan * MAX_ITD_S : 0;
    const delayR = pan < 0 ? -pan * MAX_ITD_S : 0;

    const baseCutoff = clamp(5600 - distCells * 520, 1400, 5600);
    const behindFactor = 1 - 0.35 * behindMix;
    const nearCutoff = baseCutoff * behindFactor;
    const farCutoff = nearCutoff * (1 - absPan * 0.33);
    const leftCutoff = pan >= 0 ? farCutoff : nearCutoff;
    const rightCutoff = pan >= 0 ? nearCutoff : farCutoff;

    this._ramp(this._gainL.gain, leftG);
    this._ramp(this._gainR.gain, rightG);
    this._ramp(this._filterL.frequency, leftCutoff);
    this._ramp(this._filterR.frequency, rightCutoff);
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
    return this._bufferSource != null || this._streamDispose != null;
  }

  /**
   * Feed a continuous AudioNode into the spatial chain (oscillators, etc.). Stops any buffer playback.
   * @param {AudioNode} inputNode Last node before the spatial splitter (e.g. output of a GainNode).
   * @param {() => void} dispose Stops/disconnects the streaming graph when {@link stop} runs.
   */
  attachStream(inputNode, dispose) {
    this.stop();
    this._streamDispose = dispose;
    // Duplicate the incoming stream to both channels before the splitter stage.
    // This preserves the requested chain while keeping mono sources fully audible.
    inputNode.connect(this._preSplitMerger, 0, 0);
    inputNode.connect(this._preSplitMerger, 0, 1);
  }

  play() {
    this.stop();
    const src = this.audioContext.createBufferSource();
    src.buffer = this.soundBuffer;
    src.loop = this.loop;
    src.connect(this._preSplitMerger, 0, 0);
    src.connect(this._preSplitMerger, 0, 1);
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
    if (this._streamDispose) {
      this._streamDispose();
      this._streamDispose = null;
    }
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
