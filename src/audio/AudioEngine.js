/**
 * Resonance Audio scene + listener heading (deg) for SpatialSource panning.
 */
import * as ResonanceAudioSdk from 'resonance-audio';
import { formatCell } from '../engine/GridEngine.js';
import { SpatialSource } from './SpatialSource.js';

const roomPresetsUrl = new URL('../data/rooms/presets.json', import.meta.url);

/**
 * Resolve ResonanceAudio constructor across ESM/CJS wrapper variants.
 * @returns {(new (ctx: AudioContext) => { output: AudioNode; setRoomProperties: Function; createSource: Function }) | null}
 */
function resolveResonanceAudioCtor() {
  const sdk = /** @type {Record<string, unknown>} */ (ResonanceAudioSdk);
  const direct = sdk.ResonanceAudio;
  if (typeof direct === 'function') return /** @type {any} */ (direct);

  const def = /** @type {Record<string, unknown> | undefined} */ (sdk.default);
  if (def && typeof def.ResonanceAudio === 'function') return /** @type {any} */ (def.ResonanceAudio);
  if (typeof sdk.default === 'function') return /** @type {any} */ (sdk.default);

  return null;
}

/** Fixed vertical extent for all presets (m). Horizontal audio is unaffected per spec. */
const ROOM_HEIGHT_M = 3;

/**
 * Level JSON / presets.json material keys → resonance-audio SDK material ids.
 * @type {Record<string, string>}
 */
const MATERIAL_NAME_TO_RESONANCE = {
  transparent: 'transparent',
  brickBare: 'brick-bare',
  brickPainted: 'brick-painted',
  parquetOnConcrete: 'parquet-on-concrete',
  concreteRough: 'concrete-block-coarse',
  concreteSmooth: 'polished-concrete-or-tile',
  wood: 'wood-panel',
  metal: 'metal',
  glass: 'glass-thin',
};

/** @type {AudioContext | null} */
export let audioContext = null;

/** @param {number} deg */
function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * @param {Record<string, unknown>} mats
 * @returns {import('resonance-audio').Utils.RoomMaterials}
 */
function jsonMaterialsToResonance(mats) {
  const floor = mats.floor;
  const ceiling = mats.ceiling;
  return {
    left: MATERIAL_NAME_TO_RESONANCE[/** @type {string} */ (mats.left)] ?? 'transparent',
    right: MATERIAL_NAME_TO_RESONANCE[/** @type {string} */ (mats.right)] ?? 'transparent',
    front: MATERIAL_NAME_TO_RESONANCE[/** @type {string} */ (mats.front)] ?? 'transparent',
    back: MATERIAL_NAME_TO_RESONANCE[/** @type {string} */ (mats.back)] ?? 'transparent',
    down: MATERIAL_NAME_TO_RESONANCE[/** @type {string} */ (floor)] ?? 'transparent',
    up: MATERIAL_NAME_TO_RESONANCE[/** @type {string} */ (ceiling)] ?? 'transparent',
  };
}

export class AudioEngine {
  constructor() {
    /** @type {InstanceType<typeof ResonanceAudio> | null} */
    this.resonanceAudio = null;
    /** Listener yaw on horizontal plane (deg, 0–360), for SpatialSource. */
    this.headingDeg = 0;
    /** @type {boolean} */
    this._initialized = false;
    /** `null` until fetch settles (success or failure). */
    /** @type {Map<string, Record<string, unknown>> | null} */
    this._roomPresetMap = null;
    /** @type {string | null} */
    this._pendingRoomPreset = null;
    /** @type {Set<SpatialSource>} */
    this._staticSources = new Set();
  }

  init() {
    if (this._initialized) return;
    this._initialized = true;

    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const ResonanceAudioCtor = resolveResonanceAudioCtor();
    if (!ResonanceAudioCtor) return;

    audioContext = new AudioContextCtor();
    this.resonanceAudio = new ResonanceAudioCtor(audioContext);
    this.resonanceAudio.output.connect(audioContext.destination);

    this._roomPresetMap = null;
    this._pendingRoomPreset = null;
    void fetch(roomPresetsUrl)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        const map = new Map();
        if (Array.isArray(list)) {
          for (const p of list) {
            if (p && typeof p === 'object' && typeof p.id === 'string') {
              map.set(p.id, /** @type {Record<string, unknown>} */ (p));
            }
          }
        }
        this._roomPresetMap = map;
        const pending = this._pendingRoomPreset;
        this._pendingRoomPreset = null;
        if (pending) this.setRoomPreset(pending);
      })
      .catch(() => {
        this._roomPresetMap = new Map();
        const pending = this._pendingRoomPreset;
        this._pendingRoomPreset = null;
        if (pending) this.setRoomPreset(pending);
      });
  }

  /**
   * @param {number} headingDegrees
   */
  setListenerOrientation(headingDegrees) {
    this.headingDeg = normalizeDeg(headingDegrees);
  }

  /**
   * Sync listener transform in Resonance Audio space.
   * @param {{ x: number; y: number }} gridPos
   * @param {number} headingDegrees
   */
  setListenerTransform(gridPos, headingDegrees) {
    this.setListenerOrientation(headingDegrees);
    const ra = this.resonanceAudio;
    if (!ra || !gridPos) return;

    const mx = Number(gridPos.x) * 1.5;
    const mz = Number(gridPos.y) * 1.5;
    const headingRad = (this.headingDeg * Math.PI) / 180;
    const fx = Math.sin(headingRad);
    const fz = -Math.cos(headingRad);

    try {
      if (typeof ra.setListenerPosition === 'function') {
        ra.setListenerPosition(mx, 0, mz);
      }
      if (typeof ra.setListenerOrientation === 'function') {
        ra.setListenerOrientation(fx, 0, fz, 0, 1, 0);
      }
    } catch {
      /* best-effort: keep running even if SDK surface varies by build */
    }
  }

  /**
   * @param {string} name Preset id (matches level `reverbPreset` and entries in presets.json).
   */
  setRoomPreset(name) {
    const id = String(name || '');
    if (!id || !this.resonanceAudio) return;

    if (this._roomPresetMap === null) {
      this._pendingRoomPreset = id;
      return;
    }

    const raw = this._roomPresetMap.get(id);
    if (!raw || typeof raw !== 'object') return;

    const dims = raw.dimensions;
    const mats = raw.materials;
    if (!dims || typeof dims !== 'object' || !mats || typeof mats !== 'object') return;

    const w = Number(/** @type {{ width?: unknown }} */ (dims).width);
    const d = Number(/** @type {{ depth?: unknown }} */ (dims).depth);
    if (!Number.isFinite(w) || !Number.isFinite(d)) return;

    const dimensions = { width: w, height: ROOM_HEIGHT_M, depth: d };
    const materials = jsonMaterialsToResonance(/** @type {Record<string, unknown>} */ (mats));
    this.resonanceAudio.setRoomProperties(dimensions, materials);
  }

  /**
   * Key-style static / radio noise at a grid cell, spatialized. Loops until {@link SpatialSource#stop}.
   * @param {number} gridX
   * @param {number} gridY
   * @returns {SpatialSource | null}
   */
  createStaticSource(gridX, gridY) {
    const ctx = audioContext;
    const ra = this.resonanceAudio;
    if (!ctx || !ra) return null;

    const osc = ctx.createOscillator();
    /** @type {AudioNode} */
    let sourceTail = osc;
    try {
      osc.type = 'white';
    } catch {
      /* invalid type */
    }
    if (osc.type !== 'white') {
      osc.type = 'sawtooth';
      osc.frequency.value = 80;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 0.5;
      osc.connect(bp);
      sourceTail = bp;
    }

    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    sourceTail.connect(gain);

    const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
    const spatial = new SpatialSource({
      audioContext: ctx,
      resonanceAudio: ra,
      cell: formatCell(gridX, gridY),
      soundBuffer: silent,
      loop: false,
      baseVolume: 1,
    });

    const dispose = () => {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      try {
        gain.disconnect();
      } catch {
        /* */
      }
    };

    spatial.attachStream(gain, dispose);
    osc.start(0);
    this._staticSources.add(spatial);

    return spatial;
  }

  /**
   * Keep static sources (e.g. key hiss) synced with listener movement/heading.
   * @param {{ x: number; y: number }} listenerGridPos
   * @param {number} listenerHeadingDeg
   */
  updateStaticSourceFilters(listenerGridPos, listenerHeadingDeg) {
    for (const source of this._staticSources) {
      source.updateDirectionalFilter(listenerGridPos, listenerHeadingDeg);
    }
  }

  /** @param {SpatialSource | null | undefined} source */
  removeStaticSource(source) {
    if (!source) return;
    source.stop();
    this._staticSources.delete(source);
  }

  clearStaticSources() {
    for (const source of this._staticSources) {
      source.stop();
    }
    this._staticSources.clear();
  }
}

export const audioEngine = new AudioEngine();
