/**
 * Resonance Audio scene + listener heading (deg) for SpatialSource panning.
 */
import * as ResonanceAudioSdk from 'resonance-audio';

const { ResonanceAudio } = ResonanceAudioSdk;

/** Fixed vertical extent for all presets (m). Horizontal audio is unaffected per spec. */
const ROOM_HEIGHT_M = 3;

/** Resonance SDK material ids (hyphenated). */
const M = {
  brickBare: 'brick-bare',
  brickPainted: 'brick-painted',
  parquetOnConcrete: 'parquet-on-concrete',
  /** Rough concrete: closest match in resonance-audio. */
  concreteRough: 'concrete-block-coarse',
  /** Smooth concrete: polished concrete / tile. */
  concreteSmooth: 'polished-concrete-or-tile',
};

/** @type {AudioContext | null} */
export let audioContext = null;

/** @param {number} deg */
function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** @param {string} mat */
function allSurfaces(mat) {
  return {
    left: mat,
    right: mat,
    front: mat,
    back: mat,
    up: mat,
    down: mat,
  };
}

/** Preset name → dimensions (m) + materials for setRoomProperties. */
const ROOM_PRESETS = {
  'small-room': {
    dimensions: { width: 4, height: ROOM_HEIGHT_M, depth: 4 },
    materials: {
      left: M.brickBare,
      right: M.brickBare,
      front: M.brickBare,
      back: M.brickBare,
      up: M.brickBare,
      down: M.parquetOnConcrete,
    },
  },
  corridor: {
    dimensions: { width: 2, height: ROOM_HEIGHT_M, depth: 12 },
    materials: allSurfaces(M.concreteRough),
  },
  'large-hall': {
    dimensions: { width: 12, height: ROOM_HEIGHT_M, depth: 20 },
    materials: allSurfaces(M.concreteSmooth),
  },
  basement: {
    dimensions: { width: 5, height: ROOM_HEIGHT_M, depth: 6 },
    materials: {
      left: M.brickPainted,
      right: M.brickPainted,
      front: M.brickPainted,
      back: M.brickPainted,
      up: M.brickPainted,
      down: M.concreteRough,
    },
  },
};

export class AudioEngine {
  constructor() {
    /** @type {InstanceType<typeof ResonanceAudio> | null} */
    this.resonanceAudio = null;
    /** Listener yaw on horizontal plane (deg, 0–360), for SpatialSource. */
    this.headingDeg = 0;
    /** @type {boolean} */
    this._initialized = false;
  }

  init() {
    if (this._initialized) return;
    this._initialized = true;

    audioContext = new AudioContext();
    this.resonanceAudio = new ResonanceAudio(audioContext);
    this.resonanceAudio.output.connect(audioContext.destination);
  }

  /**
   * @param {number} headingDegrees
   */
  setListenerOrientation(headingDegrees) {
    this.headingDeg = normalizeDeg(headingDegrees);
  }

  /**
   * @param {string} name
   */
  setRoomPreset(name) {
    const preset = ROOM_PRESETS[name];
    if (!preset || !this.resonanceAudio) return;
    this.resonanceAudio.setRoomProperties(preset.dimensions, preset.materials);
  }

}

export const audioEngine = new AudioEngine();
