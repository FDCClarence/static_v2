/**
 * Stereo feed into Resonance Audio (grid-based world positions).
 * Panning comes only from Resonance; this chain stays gain-matched L/R.
 */
import { parseCell } from '../engine/GridEngine.js';

const CELL_METERS = 1.5;
const RAMP_S = 0.016;

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
    this._frontBackFilter = audioContext.createBiquadFilter();
    this._splitter = audioContext.createChannelSplitter(2);
    this._gainL = audioContext.createGain();
    this._gainR = audioContext.createGain();
    this._filterL = audioContext.createBiquadFilter();
    this._filterR = audioContext.createBiquadFilter();
    this._delayL = audioContext.createDelay(1);
    this._delayR = audioContext.createDelay(1);
    this._merger = audioContext.createChannelMerger(2);
    this._frontGainNode = audioContext.createGain();

    this._frontBackFilter.type = 'lowpass';
    this._frontBackFilter.frequency.value = 20000;
    for (const f of [this._filterL, this._filterR]) {
      f.type = 'lowpass';
      f.frequency.value = 800;
    }
    this._delayL.delayTime.value = 0;
    this._delayR.delayTime.value = 0;
    this._frontGainNode.gain.value = 1;

    this._preSplitMerger.connect(this._frontBackFilter);
    this._frontBackFilter.connect(this._splitter);
    this._splitter.connect(this._gainL, 0);
    this._splitter.connect(this._gainR, 1);
    this._gainL.connect(this._filterL);
    this._filterL.connect(this._delayL);
    this._delayL.connect(this._merger, 0, 0);
    this._gainR.connect(this._filterR);
    this._filterR.connect(this._delayR);
    this._delayR.connect(this._merger, 0, 1);

    this._resSource = resonanceAudio.createSource();
    this._merger.connect(this._frontGainNode);
    this._frontGainNode.connect(this._resSource.input);

    /** Mono envelope before splitter (buffer path only; streams connect straight to {@link _preSplitMerger}). */
    this._envelopeGain = audioContext.createGain();
    this._envelopeGain.gain.value = 1;

    /** @type {AudioBufferSourceNode | null} */
    this._bufferSource = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._fadeOutTimer = null;
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

    this._syncResonancePosition();

    // Angle between player's facing direction and direction to this source.
    // Heading 0 = North = -y in grid space; 90 = East = +x.
    const headingRad = (listenerHeadingDeg * Math.PI) / 180;
    const faceX = Math.sin(headingRad);
    const faceY = -Math.cos(headingRad);
    const dx = this._gridPos.x - listenerGridPos.x;
    const dy = this._gridPos.y - listenerGridPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const cosAngle = faceX * (dx / dist) + faceY * (dy / dist);
    const normalized = (cosAngle + 1) / 2; // 0 = rear, 1 = front

    const frontBackCutoff =
      cosAngle > 0 ? 20000 : 800 + (cosAngle + 1) * 3600;
    const frontGain = 0.85 + normalized * 0.3;

    const vol = this._baseVolume * this._userVolume;
    const cutoff = 3200;
    this._ramp(this._gainL.gain, vol);
    this._ramp(this._gainR.gain, vol);
    this._ramp(this._filterL.frequency, cutoff);
    this._ramp(this._filterR.frequency, cutoff);
    this._ramp(this._delayL.delayTime, 0);
    this._ramp(this._delayR.delayTime, 0);
    this._ramp(this._frontBackFilter.frequency, frontBackCutoff);
    this._ramp(this._frontGainNode.gain, frontGain);
  }

  /**
   * @param {string} cell
   */
  setPosition(cell) {
    this._gridPos = parseCell(cell);
    this.updateDirectionalFilter(this._lastListenerGridPos, this._lastListenerHeadingDeg);
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
    inputNode.connect(this._preSplitMerger, 0, 0);
    inputNode.connect(this._preSplitMerger, 0, 1);
  }

  /**
   * @param {{ fadeInSeconds?: number }} [options]
   */
  play(options = {}) {
    this.stop();
    const fadeIn = typeof options.fadeInSeconds === 'number' && options.fadeInSeconds > 0 ? options.fadeInSeconds : 0;
    const src = this.audioContext.createBufferSource();
    src.buffer = this.soundBuffer;
    src.loop = this.loop;
    this._envelopeGain.connect(this._preSplitMerger, 0, 0);
    this._envelopeGain.connect(this._preSplitMerger, 0, 1);
    src.connect(this._envelopeGain);
    const g = this._envelopeGain.gain;
    const t = this.audioContext.currentTime;
    g.cancelScheduledValues(t);
    if (fadeIn > 0) {
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(1, t + fadeIn);
    } else {
      g.setValueAtTime(1, t);
    }
    src.onended = () => {
      if (this._bufferSource === src) {
        this._bufferSource = null;
        this._detachEnvelopeFromMerger();
        this.onPlaybackEnded?.();
      }
    };
    this._bufferSource = src;
    src.start(0);
  }

  _detachEnvelopeFromMerger() {
    try {
      this._envelopeGain.disconnect();
    } catch {
      /* */
    }
  }

  _hardStopBufferSource() {
    if (!this._bufferSource) return;
    try {
      this._bufferSource.stop();
    } catch {
      /* already stopped */
    }
    this._bufferSource.disconnect();
    this._bufferSource = null;
    this._detachEnvelopeFromMerger();
    const t = this.audioContext.currentTime;
    this._envelopeGain.gain.cancelScheduledValues(t);
    this._envelopeGain.gain.setValueAtTime(1, t);
  }

  /**
   * @param {{ fadeOutSeconds?: number; onComplete?: () => void }} [options]
   */
  stop(options = {}) {
    if (this._fadeOutTimer) {
      clearTimeout(this._fadeOutTimer);
      this._fadeOutTimer = null;
    }
    if (this._streamDispose) {
      this._streamDispose();
      this._streamDispose = null;
    }
    const fadeOut =
      typeof options.fadeOutSeconds === 'number' && options.fadeOutSeconds > 0 ? options.fadeOutSeconds : 0;
    if (!this._bufferSource) {
      options.onComplete?.();
      return;
    }
    if (fadeOut <= 0) {
      this._hardStopBufferSource();
      options.onComplete?.();
      return;
    }
    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const g = this._envelopeGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fadeOut);
    const src = this._bufferSource;
    const ms = fadeOut * 1000 + 100;
    this._fadeOutTimer = setTimeout(() => {
      this._fadeOutTimer = null;
      if (this._bufferSource !== src) {
        options.onComplete?.();
        return;
      }
      this._hardStopBufferSource();
      options.onComplete?.();
    }, ms);
  }

  /**
   * @param {number} v
   */
  setVolume(v) {
    this._userVolume = v;
    this.updateDirectionalFilter(this._lastListenerGridPos, this._lastListenerHeadingDeg);
  }

  /**
   * @param {number} v
   */
  setBaseVolume(v) {
    this._baseVolume = v;
    this.updateDirectionalFilter(this._lastListenerGridPos, this._lastListenerHeadingDeg);
  }
}
