/**
 * Subscribes to game events and drives spatial audio + master bus.
 */
import { audioContext, audioEngine } from './AudioEngine.js';
import { SpatialSource } from './SpatialSource.js';
import { gameEvents } from '../engine/EventEmitter.js';
import { formatCell, parseCell } from '../engine/GridEngine.js';
import creatureRegistry from '../data/creatures/registry.js';
import objectRegistry from '../data/objects/registry.js';

/** Current player cell for panning; game may also set via PLAYER_MOVED payload. */
export const playerAudioGrid = { x: 0, y: 0 };

/** @param {number} deg */
function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

const MASTER_FADE_S = 2;
const DEATH_RESET_DELAY_S = 3;
const RAMP_TAIL_S = 0.02;
const AUDIO_ASSETS_ENABLED =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('audio') === '1';

/** Short pulse when movement is blocked (Vibration API; common on Android; iOS often no-ops). */
const BLOCK_BUMP_VIBRATE_MS = 35;

function tryBlockedMoveVibrate() {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(BLOCK_BUMP_VIBRATE_MS);
  } catch {
    /* */
  }
}

/** Decode WAVs from `public/audio/` (Vite: BASE_URL; plain ESM has no import.meta.env). */
function assetUrl(file) {
  const base = import.meta.env?.BASE_URL;
  if (typeof base === 'string' && base !== '') {
    const prefix = base.endsWith('/') ? base : `${base}/`;
    return `${prefix}audio/${file}`;
  }
  return new URL(`../../audio/${file}`, import.meta.url).href;
}

const SFX_BASE_CANDIDATES = ['assets/sfx', 'public/assets/sfx'];
let _resolvedSfxBase = null;

/**
 * Pick one working public SFX base path so we avoid repeated 404 noise.
 * @returns {Promise<string>}
 */
async function resolveSfxBase() {
  if (typeof window === 'undefined') return SFX_BASE_CANDIDATES[0];
  if (_resolvedSfxBase) return _resolvedSfxBase;

  // If page bootstraps directly from main.js, it's likely serving source files.
  const moduleScript = document.querySelector('script[type="module"][src]');
  const scriptSrc = moduleScript?.getAttribute('src') ?? '';
  const candidates =
    scriptSrc.includes('main.js') ? ['public/assets/sfx', 'assets/sfx'] : SFX_BASE_CANDIDATES;

  const probeFile = 'walking-wood.mp3';
  for (const base of candidates) {
    const url = new URL(`${base}/${probeFile}`, document.baseURI).href;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {
        _resolvedSfxBase = base;
        return base;
      }
    } catch {
      // try next candidate
    }
  }

  _resolvedSfxBase = candidates[0];
  return _resolvedSfxBase;
}

/**
 * @param {string} base
 * @param {string} file
 */
function sfxUrl(base, file) {
  if (typeof window === 'undefined') return `${base}/${file}`;
  return new URL(`${base}/${file}`, document.baseURI).href;
}

/** Optional decode URLs (add files under /public/audio/). */
const URLS = {
  footstep: {
    default: assetUrl('footstep_default.wav'),
    wood: assetUrl('footstep_wood.wav'),
    tile: assetUrl('footstep_tile.wav'),
    carpet: assetUrl('footstep_carpet.wav'),
    metal: assetUrl('footstep_metal.wav'),
    concrete: assetUrl('footstep_concrete.wav'),
    parquet: assetUrl('footstep_parquet.wav'),
  },
  bump: assetUrl('bump.wav'),
  death: assetUrl('death.wav'),
  creature: {
    default: assetUrl('creature_default.wav'),
  },
};
const SFX_FILES = {
  walkingWood: 'walking-wood.mp3',
  keyGrab: 'key-grab.mp3',
  keySound: 'key-sound.mp3',
  findTheKey: 'barrack-find-the-key.wav',
  findTheDoor: 'barrack-find-the-door-3.mp3',
  doorBump: 'door-bump.mp3',
  attemptOpenLockedDoor: 'attempt-open-locked-door.mp3',
  openDoorWithKey: 'open-door-with-key.mp3',
  wallBump: 'wall-bump.mp3',
  backroomsBgMusic: 'backrooms-bg-music.mp3',
  landingPageMusic: 'landing-page-music.mp3',
  gameOverMusic: 'charlie-kirk.mp3',
  zombieGasp: 'zombie-gasp.wav',
};
const MUSIC_FADE_S = 0.8;

/**
 * URLs to try for a creature `ambient_sound` / `move_sound` ref (basename in sfx folder, relative path, site-root path, or http).
 * @param {string} sfxBase
 * @param {string} ref
 * @returns {string[]}
 */
function creatureSoundUrlsToTry(sfxBase, ref) {
  const s = ref.trim();
  if (!s) return [];
  if (/^https?:\/\//i.test(s)) return [s];
  if (typeof document !== 'undefined') {
    if (s.startsWith('/')) {
      return [new URL(s, document.baseURI).href];
    }
    if (s.includes('/')) {
      return [new URL(s, document.baseURI).href];
    }
  }
  if (/\.(mp3|wav|ogg)$/i.test(s)) {
    return [sfxUrl(sfxBase, s)];
  }
  return [sfxUrl(sfxBase, `${s}.mp3`), sfxUrl(sfxBase, `${s}.wav`)];
}

/**
 * @param {AudioContext} ctx
 * @param {string} sfxBase
 * @param {unknown} ref
 * @returns {Promise<AudioBuffer | null>}
 */
async function decodeCreatureSound(ctx, sfxBase, ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  for (const url of creatureSoundUrlsToTry(sfxBase, ref)) {
    const buf = await decodeUrl(ctx, url);
    if (buf) return buf;
  }
  return null;
}

/**
 * Object ambient/move: sfx + paths first; bare names also try `public/audio/` (legacy object ambients).
 * @param {AudioContext} ctx
 * @param {string} sfxBase
 * @param {string} ref
 * @returns {Promise<AudioBuffer | null>}
 */
async function decodeRegistryAmbientSound(ctx, sfxBase, ref) {
  const fromSfx = await decodeCreatureSound(ctx, sfxBase, ref);
  if (fromSfx) return fromSfx;
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const s = ref.trim();
  if (/^https?:\/\//i.test(s) || s.includes('/')) return null;
  const file = /\.(mp3|wav|ogg)$/i.test(s) ? s : `${s}.wav`;
  return decodeUrl(ctx, assetUrl(file));
}

/** Map arbitrary floorType strings to footstep asset keys. */
const FLOOR_TYPE_ALIASES = {
  floor: 'default',
  parquet: 'parquet',
  parquetonconcrete: 'parquet',
  wood: 'wood',
  tile: 'tile',
  carpet: 'carpet',
  metal: 'metal',
  concrete: 'concrete',
  rough: 'concrete',
  smooth: 'tile',
  brick: 'concrete',
  brickbare: 'concrete',
  brickpainted: 'concrete',
};

/**
 * @param {unknown} detail
 * @returns {{ x: number; y: number } | null}
 */
function gridFromDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const d = /** @type {Record<string, unknown>} */ (detail);
  if (typeof d.cell === 'string') {
    try {
      return parseCell(d.cell);
    } catch {
      return null;
    }
  }
  if (typeof d.x === 'number' && typeof d.y === 'number' && Number.isFinite(d.x) && Number.isFinite(d.y)) {
    return { x: d.x, y: d.y };
  }
  const pos = d.position;
  if (pos && typeof pos === 'object') {
    const p = /** @type {Record<string, unknown>} */ (pos);
    if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
  }
  return null;
}

/**
 * @param {unknown} floorType
 * @returns {string}
 */
function footstepKeyForFloor(floorType) {
  if (floorType == null || floorType === '') return 'default';
  const k = String(floorType).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k in URLS.footstep) return k;
  if (k in FLOOR_TYPE_ALIASES) return FLOOR_TYPE_ALIASES[k];
  return 'default';
}

/**
 * @param {AudioContext} ctx
 * @param {string} url
 * @returns {Promise<AudioBuffer | null>}
 */
async function decodeUrl(ctx, url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.arrayBuffer();
    return await ctx.decodeAudioData(raw.slice(0));
  } catch {
    return null;
  }
}

/** Max linear gain from registry `volume` × slot volume (prevents runaway boosts). */
const REGISTRY_GAIN_CAP = 4;

/**
 * Linear gain from object registry `sounds`: `volume` × `{slot}Volume` (each defaults to 1 if omitted).
 * Slots: `worldLoopVolume`, `interactVolume`, `ambientVolume`, `bumpVolume`.
 * @param {Record<string, unknown> | undefined} sounds
 * @param {'worldLoop' | 'interact' | 'ambient' | 'bump'} slot
 */
function registryGainFromSounds(sounds, slot) {
  if (!sounds || typeof sounds !== 'object') return 1;
  const base = typeof sounds.volume === 'number' && Number.isFinite(sounds.volume) ? sounds.volume : 1;
  const slotKey =
    slot === 'worldLoop'
      ? 'worldLoopVolume'
      : slot === 'interact'
        ? 'interactVolume'
        : slot === 'ambient'
          ? 'ambientVolume'
          : 'bumpVolume';
  const slotMul =
    typeof sounds[slotKey] === 'number' && Number.isFinite(sounds[slotKey]) ? sounds[slotKey] : 1;
  const g = base * slotMul;
  return Math.max(0, Math.min(g, REGISTRY_GAIN_CAP));
}

export class AudioEventBus {
  constructor() {
    /** @type {import('../engine/InputManager.js').InputManager | null} */
    this._inputManager = null;
    /** @type {GainNode | null} */
    this._masterGain = null;
    /** @type {boolean} */
    this._masterPatched = false;
    /** @type {Set<SpatialSource>} */
    this._directionalSources = new Set();
    /** @type {Map<string, SpatialSource>} */
    this._ambientById = new Map();
    /** @type {Map<string, SpatialSource>} */
    this._creatureById = new Map();
    /** Active non-looping world spatial one-shots (aura/move/object cues) that must be stoppable on scene transitions. */
    /** @type {Set<SpatialSource>} */
    this._worldOneShotSources = new Set();
    /** @type {Map<string, { source: SpatialSource; fadeOutSec: number }>} Spatial world loops (registry `ambient_sound`). */
    this._worldAmbientLoopsById = new Map();
    /** @type {Map<string, Record<string, unknown>>} Object `sounds` from registry, keyed by object type id. */
    this._objectSoundsByTypeId = new Map();
    /** Registry object id → decoded `sounds.ambient_sound`. */
    /** @type {Map<string, AudioBuffer>} */
    this._objectAmbientBufferByTypeId = new Map();
    /** Registry object id → decoded `sounds.move_sound`. */
    /** @type {Map<string, AudioBuffer>} */
    this._objectMoveBufferByTypeId = new Map();
    /** Registry object id → decoded `sounds.interact_sound`. */
    /** @type {Map<string, AudioBuffer>} */
    this._objectInteractBufferByTypeId = new Map();
    /** Registry object id → `sounds.ambient_timer` (seconds between timed ambient one-shots; >0 disables looping spatial ambient). */
    /** @type {Map<string, number>} */
    this._objectAmbientTimerSecByTypeId = new Map();
    /** Object instance id → timed ambient state when `ambient_timer` &gt; 0. */
    /** @type {Map<string, { anchorMs: number; x: number; y: number; objectType: string }>} */
    this._objectTimedAmbientByInstanceId = new Map();

    /** @type {SpatialSource | null} */
    this._footstepSource = null;
    /** @type {SpatialSource | null} */
    this._bumpSource = null;
    /** @type {GainNode | null} */
    this._deathDirectGain = null;
    /** @type {AudioBufferSourceNode | null} */
    this._deathDirectSource = null;

    /** @type {boolean} */
    this._busInitialized = false;

    /** @type {Record<string, AudioBuffer | null>} */
    this._buffers = {
      bump: null,
      death: null,
    };
    /** @type {Record<string, AudioBuffer | null>} */
    this._footstepBuffers = {};
    /** @type {Record<string, AudioBuffer | null>} */
    this._ambientBuffers = {};
    /** @type {Record<string, AudioBuffer | null>} */
    this._creatureBuffers = {};
    /** Registry creature id → decoded `sounds.ambient_sound`. */
    /** @type {Map<string, AudioBuffer>} */
    this._creatureAmbientByTypeId = new Map();
    /** Registry creature id → decoded `sounds.move_sound`. */
    /** @type {Map<string, AudioBuffer>} */
    this._creatureMoveSoundByTypeId = new Map();
    /** Registry creature id → `sounds.ambient_timer` (seconds between idle ambient one-shots; >0 also disables looping spatial ambient). */
    /** @type {Map<string, number>} */
    this._creatureAmbientTimerSecByTypeId = new Map();
    /** Registry creature id → linear gain multiplier (`volume` field, default 1). */
    /** @type {Map<string, number>} */
    this._creatureVolumeByTypeId = new Map();
    /** Registry creature id → decoded `sounds.aura_sound` buffer. */
    /** @type {Map<string, AudioBuffer>} */
    this._creatureAuraSoundByTypeId = new Map();
    /** Registry creature id → `aura_sound_distance` in tiles (Chebyshev). */
    /** @type {Map<string, number>} */
    this._creatureAuraDistanceByTypeId = new Map();
    /** Registry creature id → `aura_sound_volume` gain multiplier. */
    /** @type {Map<string, number>} */
    this._creatureAuraVolumeByTypeId = new Map();
    /** Instance ids of creatures currently inside their aura distance (prevents re-firing). */
    /** @type {Set<string>} */
    this._creatureAuraActiveIds = new Set();
    /** Registry creature id → decoded `sounds.aura_sound_first_entry` buffer. */
    /** @type {Map<string, AudioBuffer>} */
    this._creatureAuraFirstEntrySoundByTypeId = new Map();
    /** Registry creature id → decoded `sounds.kill_sound` buffer. */
    /** @type {Map<string, AudioBuffer>} */
    this._creatureKillSoundByTypeId = new Map();
    /** Registry creature id → `sounds.kill_sound_volume` gain multiplier. */
    /** @type {Map<string, number>} */
    this._creatureKillSoundVolumeByTypeId = new Map();
    /** Instance ids that have already had their first-entry aura sound played (never repeats). */
    /** @type {Set<string>} */
    this._creatureAuraFirstEntryFiredIds = new Set();
    /** During aura first-entry cue, suppress all non-aura creature audio until this timestamp (ms). */
    /** @type {number} */
    this._creatureAuraPriorityUntilMs = 0;
    /** Last known position + typeId for every live creature (updated each CREATURE_TICK). */
    /** @type {Map<string, { x: number; y: number; creatureTypeId: string }>} */
    this._knownCreaturePositions = new Map();
    /** @type {Record<string, AudioBuffer | null>} */
    this._sfxBuffers = {
      walkingWood: null,
      keyGrab: null,
      keySound: null,
      findTheKey: null,
      findTheDoor: null,
      doorBump: null,
      attemptOpenLockedDoor: null,
      openDoorWithKey: null,
      wallBump: null,
      backroomsBgMusic: null,
      landingPageMusic: null,
       gameOverMusic: null,
    };
    /** @type {AudioBufferSourceNode | null} */
    this._bgMusicSource = null;
    /** @type {GainNode | null} */
    this._bgMusicGain = null;
    /** @type {AudioBufferSourceNode | null} */
    this._landingMusicSource = null;
    /** @type {GainNode | null} */
    this._landingMusicGain = null;
    /** @type {AudioBufferSourceNode | null} */
    this._gameOverMusicSource = null;
    /** @type {GainNode | null} */
    this._gameOverMusicGain = null;
    /** @type {boolean} */
    this._wantBgMusic = false;
    /** @type {boolean} */
    this._wantLandingMusic = false;
    /** @type {boolean} */
    this._wantGameOverMusic = false;

    /** @type {boolean} */
    this._deathInProgress = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._deathResetTimer = null;
    /** While the game-over overlay is up: no spatial world / creature / object gameplay SFX. */
    /** @type {boolean} */
    this._gameOverWorldMuted = false;

    /** Stalk-behavior timed ambient: instance id → timer anchor, grid pos, registry creature type. */
    /** @type {Map<string, { anchorMs: number; x: number; y: number; creatureTypeId: string }>} */
    this._stalkerIdleGaspById = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this._stalkerIdleGaspInterval = null;
    /** Stalker instance id → current move one-shot source (for first-entry cancellation). */
    /** @type {Map<string, SpatialSource>} */
    this._stalkerMoveOneShotById = new Map();

    /** Last smoothed heading used for Resonance (matches INPUT_TICK; not raw gyro). */
    this._spatialHeading = 0;

    this._onInputTick = this._onInputTick.bind(this);
    this._onPlayerMoved = this._onPlayerMoved.bind(this);
    this._onPlayerBlocked = this._onPlayerBlocked.bind(this);
    this._onKeyCollected = this._onKeyCollected.bind(this);
    this._onLevelExited = this._onLevelExited.bind(this);
    this._onObjectAmbient = this._onObjectAmbient.bind(this);
    this._onCreatureTick = this._onCreatureTick.bind(this);
    this._onPlayerDeath = this._onPlayerDeath.bind(this);
    this._onResetGame = this._onResetGame.bind(this);
    this._onStalkerIdleClear = this._onStalkerIdleClear.bind(this);
    this._onStalkerSpawned = this._onStalkerSpawned.bind(this);
    this._onStalkerMove = this._onStalkerMove.bind(this);
    this._tickTimedAmbients = this._tickTimedAmbients.bind(this);
  }

  /**
   * @param {{ inputManager: import('../engine/InputManager.js').InputManager }} opts
   */
  async init(opts) {
    if (this._busInitialized) return;
    this._inputManager = opts.inputManager;

    await this._ensureAudioReady();
    this._patchMasterGain();
    this._initDeathDirectGain();

    gameEvents.on('INPUT_TICK', this._onInputTick);
    gameEvents.on('PLAYER_MOVED', this._onPlayerMoved);
    gameEvents.on('PLAYER_BLOCKED', this._onPlayerBlocked);
    gameEvents.on('KEY_COLLECTED', this._onKeyCollected);
    gameEvents.on('LEVEL_EXITED', this._onLevelExited);
    gameEvents.on('OBJECT_AMBIENT', this._onObjectAmbient);
    gameEvents.on('CREATURE_TICK', this._onCreatureTick);
    gameEvents.on('PLAYER_DEATH', this._onPlayerDeath);
    gameEvents.on('RESET_GAME', this._onResetGame);
    gameEvents.on('STALKER_IDLE_CLEAR', this._onStalkerIdleClear);
    gameEvents.on('STALKER_SPAWNED', this._onStalkerSpawned);
    gameEvents.on('STALKER_MOVE', this._onStalkerMove);

    await this._loadBuffers();
    this._createOneShotSources();
    this._stalkerIdleGaspInterval = setInterval(this._tickTimedAmbients, 1000);
    this._busInitialized = true;
  }

  _initDeathDirectGain() {
    const ctx = audioContext;
    if (!ctx || this._deathDirectGain) return;
    this._deathDirectGain = ctx.createGain();
    this._deathDirectGain.gain.value = 1;
    this._deathDirectGain.connect(ctx.destination);
  }

  async _ensureAudioReady() {
    if (audioContext) await audioContext.resume().catch(() => {});
  }

  _patchMasterGain() {
    const ra = audioEngine.resonanceAudio;
    const ctx = audioContext;
    if (!ra || !ctx || this._masterPatched) return;
    this._masterGain = ctx.createGain();
    this._masterGain.gain.value = 1;
    ra.output.disconnect();
    
    // Swap L/R to correct mirrored spatial image from Resonance/Omnitone
    const split = ctx.createChannelSplitter(2);
    const swap = ctx.createChannelMerger(2);
    ra.output.connect(split);
    split.connect(swap, 0, 1); // L → R
    split.connect(swap, 1, 0); // R → L
    swap.connect(this._masterGain);
    
    this._masterGain.connect(ctx.destination);
    this._masterPatched = true;
  }

  /**
   * Decode object registry `ambient_sound`, `ambient_timer`, `interact_sound`, `move_sound`; fill `_objectSoundsByTypeId`.
   * @param {AudioContext} ctx
   * @param {string} sfxBase
   */
  async _loadObjectRegistrySounds(ctx, sfxBase) {
    this._objectSoundsByTypeId.clear();
    this._objectAmbientBufferByTypeId.clear();
    this._objectMoveBufferByTypeId.clear();
    this._objectInteractBufferByTypeId.clear();
    this._objectAmbientTimerSecByTypeId.clear();
    for (const obj of objectRegistry) {
      if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string') continue;
      const sounds = obj.sounds && typeof obj.sounds === 'object' ? obj.sounds : {};
      this._objectSoundsByTypeId.set(obj.id, sounds);
      const ambientRef =
        typeof sounds.ambient_sound === 'string' && sounds.ambient_sound.trim()
          ? sounds.ambient_sound.trim()
          : null;
      const moveRef =
        typeof sounds.move_sound === 'string' && sounds.move_sound.trim()
          ? sounds.move_sound.trim()
          : null;
      const interactRef =
        typeof sounds.interact_sound === 'string' && sounds.interact_sound.trim()
          ? sounds.interact_sound.trim()
          : null;
      const timerRaw = sounds.ambient_timer;
      const ambientTimerSec =
        typeof timerRaw === 'number' && Number.isFinite(timerRaw) && timerRaw > 0 ? timerRaw : null;
      if (ambientTimerSec != null) {
        this._objectAmbientTimerSecByTypeId.set(obj.id, ambientTimerSec);
      }
      if (ambientRef) {
        const buf = await decodeRegistryAmbientSound(ctx, sfxBase, ambientRef);
        if (buf) this._objectAmbientBufferByTypeId.set(obj.id, buf);
      }
      if (moveRef) {
        const buf = await decodeRegistryAmbientSound(ctx, sfxBase, moveRef);
        if (buf) this._objectMoveBufferByTypeId.set(obj.id, buf);
      }
      if (interactRef) {
        const buf = await decodeRegistryAmbientSound(ctx, sfxBase, interactRef);
        if (buf) this._objectInteractBufferByTypeId.set(obj.id, buf);
      }
    }
  }

  /**
   * @param {string} [objectTypeId] Registry object id (e.g. `window`).
   * @returns {boolean}
   */
  _objectUsesTimedAmbientOnly(objectTypeId) {
    if (typeof objectTypeId !== 'string' || !objectTypeId) return false;
    const s = this._objectAmbientTimerSecByTypeId.get(objectTypeId);
    return typeof s === 'number' && Number.isFinite(s) && s > 0;
  }

  /**
   * @param {string} objectTypeId Registry object id (e.g. `key`, `door-unlocked`).
   * @returns {string | null} `sounds.ambient_sound` path when present.
   */
  getObjectAmbientSoundKey(objectTypeId) {
    const sounds = this._objectSoundsByTypeId.get(objectTypeId);
    const k = sounds && typeof sounds === 'object' ? sounds.ambient_sound : null;
    return typeof k === 'string' && k ? k : null;
  }

  /**
   * @param {string} objectTypeId
   * @param {'worldLoop' | 'interact' | 'ambient' | 'bump'} slot
   * @returns {number}
   */
  getRegistrySoundGain(objectTypeId, slot) {
    return registryGainFromSounds(this._objectSoundsByTypeId.get(objectTypeId), slot);
  }

  /**
   * Spatial loop from registry `ambient_sound` (decoded buffer) + fade seconds.
   * @param {string} objectTypeId
   * @returns {{ fadeInSec: number; fadeOutSec: number; gain: number } | null}
   */
  getObjectSpatialLoopConfig(objectTypeId) {
    const sounds = this._objectSoundsByTypeId.get(objectTypeId);
    if (!sounds || typeof sounds !== 'object') return null;
    if (!this._objectAmbientBufferByTypeId.has(objectTypeId)) return null;
    const fadeIn =
      typeof sounds.ambient_fade_in_sec === 'number' && Number.isFinite(sounds.ambient_fade_in_sec)
        ? sounds.ambient_fade_in_sec
        : typeof sounds.worldLoopFadeInSec === 'number' && Number.isFinite(sounds.worldLoopFadeInSec)
          ? sounds.worldLoopFadeInSec
          : 0;
    const fadeOut =
      typeof sounds.ambient_fade_out_sec === 'number' && Number.isFinite(sounds.ambient_fade_out_sec)
        ? sounds.ambient_fade_out_sec
        : typeof sounds.worldLoopFadeOutSec === 'number' && Number.isFinite(sounds.worldLoopFadeOutSec)
          ? sounds.worldLoopFadeOutSec
          : 0;
    return {
      fadeInSec: fadeIn,
      fadeOutSec: fadeOut,
      gain: registryGainFromSounds(sounds, 'worldLoop'),
    };
  }

  /**
   * Spatial looping SFX at a grid cell from registry `ambient_sound` paths.
   * @param {string} trackId
   * @param {number} gridX
   * @param {number} gridY
   * @param {string} registryObjectTypeId e.g. `key`, `door-unlocked`
   */
  playRegistryObjectWorldLoop(trackId, gridX, gridY, registryObjectTypeId) {
    if (this._gameOverWorldMuted) return;
    const cfg = this.getObjectSpatialLoopConfig(registryObjectTypeId);
    if (!cfg) return;
    const buf = this._objectAmbientBufferByTypeId.get(registryObjectTypeId);
    if (!buf) return;
    this.stopWorldAmbientLoop(trackId);
    const src = audioEngine.createLoopingSpatialSource(gridX, gridY, buf, {
      baseVolume: cfg.gain,
      fadeInSeconds: cfg.fadeInSec,
    });
    if (src) {
      this._worldAmbientLoopsById.set(trackId, { source: src, fadeOutSec: cfg.fadeOutSec });
      if (this._busInitialized) this.syncSpatialAudio();
    }
  }

  /**
   * @param {string} trackId
   * @param {number} gridX
   * @param {number} gridY
   * @param {string} soundKey Ambient id from object registry (decoded into `_ambientBuffers`).
   */
  playWorldAmbientLoop(trackId, gridX, gridY, soundKey) {
    if (this._gameOverWorldMuted) return;
    this.stopWorldAmbientLoop(trackId);
    const buf = this._ambientBuffers[soundKey];
    if (!buf) return;
    const src = audioEngine.createLoopingSpatialSource(gridX, gridY, buf, { baseVolume: 1 });
    if (src) {
      this._worldAmbientLoopsById.set(trackId, { source: src, fadeOutSec: 0 });
      if (this._busInitialized) this.syncSpatialAudio();
    }
  }

  /** @param {string} trackId */
  stopWorldAmbientLoop(trackId) {
    const entry = this._worldAmbientLoopsById.get(trackId);
    if (!entry) return;
    this._worldAmbientLoopsById.delete(trackId);
    audioEngine.removeSpatialLoopSource(entry.source, { fadeOutSeconds: entry.fadeOutSec });
  }

  clearWorldAmbientLoops() {
    this._worldAmbientLoopsById.clear();
    audioEngine.clearSpatialLoopSources();
  }

  async _loadBuffers() {
    const ctx = audioContext;
    if (!ctx) return;
    const sfxBase = await resolveSfxBase();
    await this._loadObjectRegistrySounds(ctx, sfxBase);
    if (AUDIO_ASSETS_ENABLED) {
      const entries = Object.entries(URLS.footstep);
      await Promise.all(
        entries.map(async ([key, url]) => {
          this._footstepBuffers[key] = await decodeUrl(ctx, url);
        }),
      );

      this._buffers.bump = await decodeUrl(ctx, URLS.bump);
      this._buffers.death = await decodeUrl(ctx, URLS.death);

      await Promise.all(
        Object.entries(URLS.creature).map(async ([key, url]) => {
          this._creatureBuffers[key] = await decodeUrl(ctx, url);
        }),
      );
    }

    await Promise.all(
      Object.entries(URLS.ambient).map(async ([key, url]) => {
        this._ambientBuffers[key] = await decodeUrl(ctx, url);
      }),
    );

    await Promise.all(
      Object.entries(SFX_FILES).map(async ([key, file]) => {
        this._sfxBuffers[key] = await decodeUrl(ctx, sfxUrl(sfxBase, file));
      }),
    );

    await this._loadCreatureRegistrySounds(ctx, sfxBase);

    // On slower networks (e.g. GH Pages), music start may be requested before large files decode.
    if (this._wantBgMusic) this.startBgMusic();
    if (this._wantLandingMusic) this.startLandingMusic();
    if (this._wantGameOverMusic) this.startGameOverMusic();
  }

  /**
   * Decode creature registry `ambient_sound`, `move_sound`, and store `ambient_timer` (seconds).
   * @param {AudioContext} ctx
   * @param {string} sfxBase
   */
  async _loadCreatureRegistrySounds(ctx, sfxBase) {
    this._creatureAmbientByTypeId.clear();
    this._creatureMoveSoundByTypeId.clear();
    this._creatureVolumeByTypeId.clear();
    this._creatureAmbientTimerSecByTypeId.clear();
    this._creatureAuraSoundByTypeId.clear();
    this._creatureAuraDistanceByTypeId.clear();
    this._creatureAuraVolumeByTypeId.clear();
    this._creatureAuraFirstEntrySoundByTypeId.clear();
    this._creatureKillSoundByTypeId.clear();
    this._creatureKillSoundVolumeByTypeId.clear();
    for (const cr of creatureRegistry) {
      if (!cr || typeof cr !== 'object') continue;
      const typeId = /** @type {{ id?: unknown; volume?: unknown; sounds?: unknown }} */ (cr).id;
      if (typeof typeId !== 'string') continue;
      const volRaw = /** @type {{ volume?: unknown }} */ (cr).volume;
      const vol =
        typeof volRaw === 'number' && Number.isFinite(volRaw) ? Math.max(0, volRaw) : 1;
      this._creatureVolumeByTypeId.set(typeId, vol);
      const sounds = /** @type {{ sounds?: Record<string, unknown> }} */ (cr).sounds;
      const snd = sounds && typeof sounds === 'object' ? sounds : null;
      const ambientRef = snd && typeof snd.ambient_sound === 'string' ? snd.ambient_sound : null;
      const moveRef = snd && typeof snd.move_sound === 'string' ? snd.move_sound : null;
      const timerRaw = snd && snd.ambient_timer;
      const ambientTimerSec =
        typeof timerRaw === 'number' && Number.isFinite(timerRaw) && timerRaw > 0 ? timerRaw : null;
      if (ambientTimerSec != null) {
        this._creatureAmbientTimerSecByTypeId.set(typeId, ambientTimerSec);
      }
      if (ambientRef) {
        const buf = await decodeCreatureSound(ctx, sfxBase, ambientRef);
        if (buf) this._creatureAmbientByTypeId.set(typeId, buf);
      }
      if (moveRef) {
        const buf = await decodeCreatureSound(ctx, sfxBase, moveRef);
        if (buf) this._creatureMoveSoundByTypeId.set(typeId, buf);
      }
      const auraRef = snd && typeof snd.aura_sound === 'string' ? snd.aura_sound : null;
      if (auraRef) {
        const buf = await decodeCreatureSound(ctx, sfxBase, auraRef);
        if (buf) {
          this._creatureAuraSoundByTypeId.set(typeId, buf);
          const distRaw = /** @type {{ aura_sound_distance?: unknown }} */ (cr).aura_sound_distance;
          const auraDist =
            typeof distRaw === 'number' && Number.isFinite(distRaw) && distRaw >= 0
              ? distRaw
              : 1;
          this._creatureAuraDistanceByTypeId.set(typeId, auraDist);
          const auraVolRaw = /** @type {{ aura_sound_volume?: unknown }} */ (cr).aura_sound_volume;
          const auraVol =
            typeof auraVolRaw === 'number' && Number.isFinite(auraVolRaw)
              ? Math.max(0, auraVolRaw)
              : 1;
          this._creatureAuraVolumeByTypeId.set(typeId, auraVol);
        }
      }
      const auraFirstRef =
        snd && typeof snd.aura_sound_first_entry === 'string' ? snd.aura_sound_first_entry : null;
      if (auraFirstRef) {
        const buf = await decodeCreatureSound(ctx, sfxBase, auraFirstRef);
        if (buf) this._creatureAuraFirstEntrySoundByTypeId.set(typeId, buf);
      }
      const killRef = snd && typeof snd.kill_sound === 'string' ? snd.kill_sound : null;
      if (killRef) {
        const buf = await decodeCreatureSound(ctx, sfxBase, killRef);
        if (buf) this._creatureKillSoundByTypeId.set(typeId, buf);
      }
      const killVolumeRaw = snd && snd.kill_sound_volume;
      if (typeof killVolumeRaw === 'number' && Number.isFinite(killVolumeRaw)) {
        this._creatureKillSoundVolumeByTypeId.set(typeId, Math.max(0, killVolumeRaw));
      }
    }
  }

  /**
   * Creatures with a positive `ambient_timer` use timed one-shots only (no looping spatial ambient clip).
   * @param {string} [typeId]
   * @returns {boolean}
   */
  _creatureUsesTimedAmbientOnly(typeId) {
    if (typeof typeId !== 'string' || !typeId) return false;
    const s = this._creatureAmbientTimerSecByTypeId.get(typeId);
    return typeof s === 'number' && Number.isFinite(s) && s > 0;
  }

  _createOneShotSources() {
    const ctx = audioContext;
    const ra = audioEngine.resonanceAudio;
    if (!ctx || !ra) return;

    const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
    const footBuf = this._footstepBuffers.default ?? silent;
    const bumpBuf = this._buffers.bump ?? silent;

    this._footstepSource = new SpatialSource({
      audioContext: ctx,
      resonanceAudio: ra,
      cell: formatCell(playerAudioGrid.x, playerAudioGrid.y),
      soundBuffer: footBuf,
      loop: false,
      baseVolume: 1,
    });

    this._bumpSource = new SpatialSource({
      audioContext: ctx,
      resonanceAudio: ra,
      cell: 'A1',
      soundBuffer: bumpBuf,
      loop: false,
      baseVolume: 1,
    });
  }

  _rampMasterGain(value, durationS) {
    const g = this._masterGain?.gain;
    const ctx = audioContext;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(value, t + durationS);
  }

  /**
   * @param {number | undefined} [headingOverride]
   */
  _refreshAllDirectional(headingOverride) {
    const im = this._inputManager;
    if (!im) return;
    const heading =
      typeof headingOverride === 'number' ? headingOverride : this._spatialHeading;
    for (const src of this._directionalSources) {
      src.updateDirectionalFilter(playerAudioGrid, heading);
    }
  }

  /**
   * Single call site: listener transform, managed spatial loops, and directional sources
   * on the same heading + grid (avoids raw/smoothed mismatch when gyro moves fast).
   * @param {number} headingDeg
   */
  _syncSpatialAudio(headingDeg) {
    const h = normalizeDeg(headingDeg);
    this._spatialHeading = h;
    audioEngine.setListenerTransform(playerAudioGrid, h);
    audioEngine.updateSpatialLoopSourceFilters(playerAudioGrid, h);
    this._refreshAllDirectional(h);
  }

  /** @returns {number} */
  _headingForSpatial() {
    const im = this._inputManager;
    return normalizeDeg(im?.smoothedHeading ?? this._spatialHeading);
  }

  /**
   * Re-apply listener, spatial loops, and directional sources for current `playerAudioGrid`.
   * Use when the grid was updated outside `PLAYER_MOVED` (e.g. key pickup: door unlock runs before that event).
   * @param {number} [headingDegOverride] Use raw/instant heading once (pickup while gyro is moving; smoothed lags).
   */
  syncSpatialAudio(headingDegOverride) {
    if (!this._busInitialized) return;
    const h =
      typeof headingDegOverride === 'number' && Number.isFinite(headingDegOverride)
        ? normalizeDeg(headingDegOverride)
        : this._headingForSpatial();
    this._syncSpatialAudio(h);
  }

  _onInputTick(detail) {
    const im = this._inputManager;
    if (!im || !audioContext) return;
    void audioContext.resume().catch(() => {});
    const tickHeading =
      detail && typeof detail === 'object' && typeof /** @type {{ heading?: unknown }} */ (detail).heading === 'number'
        ? /** @type {{ heading: number }} */ (detail).heading
        : im.smoothedHeading;
    this._syncSpatialAudio(tickHeading);
  }

  _onPlayerMoved(detail) {
    const g = gridFromDetail(detail);
    if (g) {
      playerAudioGrid.x = g.x;
      playerAudioGrid.y = g.y;
    }
    this._syncSpatialAudio(this._headingForSpatial());
    this._checkCreatureAuras(playerAudioGrid.x, playerAudioGrid.y);

    if (this._gameOverWorldMuted) return;

    const walkSfx = this._sfxBuffers.walkingWood;
    if (walkSfx) {
      this._playSfx(walkSfx, { gain: 0.2, playbackRate: 1.5 });
      return;
    }
    const floorType =
      detail && typeof detail === 'object' && 'floorType' in detail
        ? /** @type {{ floorType?: unknown }} */ (detail).floorType
        : undefined;
    const key = footstepKeyForFloor(floorType);
    const buf = this._footstepBuffers[key] ?? this._footstepBuffers.default;
    if (!this._footstepSource || !buf) return;

    this._footstepSource.setPosition(formatCell(playerAudioGrid.x, playerAudioGrid.y));
    this._footstepSource.setSoundBuffer(buf);
    this._footstepSource.onPlaybackEnded = () => {
      this._directionalSources.delete(this._footstepSource);
      if (this._footstepSource) this._footstepSource.onPlaybackEnded = null;
    };
    this._directionalSources.add(this._footstepSource);
    this._footstepSource.updateDirectionalFilter(playerAudioGrid, this._headingForSpatial());
    void audioContext?.resume().then(() => this._footstepSource?.play());
  }

  _onPlayerBlocked(detail) {
    tryBlockedMoveVibrate();
    if (this._gameOverWorldMuted) return;
    if (detail && typeof detail === 'object') {
      const objectType = /** @type {{ objectType?: unknown }} */ (detail).objectType;
      if (objectType === 'door-locked') {
        const regBuf = this._objectInteractBufferByTypeId.get('door-locked');
        const lockedSfx = regBuf ?? this._sfxBuffers.attemptOpenLockedDoor;
        if (lockedSfx) {
          this._playSfx(lockedSfx, { gain: this.getRegistrySoundGain('door-locked', 'interact') });
        }
        return;
      }
    }
    const wallBump = this._sfxBuffers.wallBump;
    if (wallBump) {
      this._playSfx(wallBump, { gain: 2 });
      return;
    }
    const g = gridFromDetail(detail);
    if (!g || !this._bumpSource) return;
    const bumpObjType =
      detail && typeof detail === 'object' && typeof /** @type {{ objectType?: unknown }} */ (detail).objectType === 'string'
        ? /** @type {{ objectType: string }} */ (detail).objectType
        : null;
    const bumpGain = bumpObjType ? this.getRegistrySoundGain(bumpObjType, 'bump') : 1;
    this._bumpSource.setBaseVolume(bumpGain);
    this._bumpSource.setPosition(formatCell(g.x, g.y));
    this._bumpSource.onPlaybackEnded = () => {
      this._directionalSources.delete(this._bumpSource);
      if (this._bumpSource) {
        this._bumpSource.setBaseVolume(1);
        this._bumpSource.onPlaybackEnded = null;
      }
    };
    this._directionalSources.add(this._bumpSource);
    this._bumpSource.updateDirectionalFilter(playerAudioGrid, this._headingForSpatial());
    void audioContext?.resume().then(() => this._bumpSource?.play());
  }

  _onKeyCollected() {
    if (this._gameOverWorldMuted) return;
    const regBuf = this._objectInteractBufferByTypeId.get('key');
    const sfx = regBuf ?? this._sfxBuffers.keyGrab;
    if (sfx) {
      this._playSfx(sfx, {
        gain: this.getRegistrySoundGain('key', 'interact'),
        onEnded: () => {
          const prompt = this._sfxBuffers.findTheDoor;
          if (prompt) this._playSfx(prompt, { gain: 1 });
        },
      });
    }
  }

  _onLevelExited() {
    this._clearSpatialWorldSources();
    const regBuf = this._objectInteractBufferByTypeId.get('door-unlocked');
    const sfx = regBuf ?? this._sfxBuffers.openDoorWithKey;
    if (sfx) {
      const rg = this.getRegistrySoundGain('door-unlocked', 'interact');
      this._playSfx(sfx, { gain: 1.5 * rg, swapStereo: true });
    }
  }

  /** Stop looping world spatial audio (level hunt cues, object ambients, creatures, engine spatial loops). */
  _clearSpatialWorldSources() {
    this._objectTimedAmbientByInstanceId.clear();
    for (const src of this._ambientById.values()) {
      src.stop();
      this._directionalSources.delete(src);
    }
    this._ambientById.clear();
    for (const src of this._creatureById.values()) {
      src.stop();
      this._directionalSources.delete(src);
    }
    this._creatureById.clear();
    for (const src of this._worldOneShotSources.values()) {
      src.stop();
      this._directionalSources.delete(src);
    }
    this._worldOneShotSources.clear();
    this._worldAmbientLoopsById.clear();
    audioEngine.clearSpatialLoopSources();
  }

  /** Landing-page BEGIN confirmation cue. */
  playBeginCueAtCell(cell) {
    const ctx = audioContext;
    const ra = audioEngine.resonanceAudio;
    const creepy = this._sfxBuffers.attemptOpenLockedDoor;
    if (!ctx || !ra || !creepy || typeof cell !== 'string') return;

    const src = new SpatialSource({
      audioContext: ctx,
      resonanceAudio: ra,
      cell,
      soundBuffer: creepy,
      loop: false,
      baseVolume: 1.35,
    });
    src.onPlaybackEnded = () => {
      this._directionalSources.delete(src);
      src.onPlaybackEnded = null;
      const prompt = this._sfxBuffers.findTheKey;
      if (prompt) this._playSfx(prompt, { gain: 1 });
    };
    this._directionalSources.add(src);
    src.updateDirectionalFilter(playerAudioGrid, this._headingForSpatial());
    void ctx.resume().then(() => src.play());
  }

  /**
   * @param {AudioBuffer} buffer
   * @param {{ gain?: number; playbackRate?: number; swapStereo?: boolean; onEnded?: (() => void) | null }} [opts]
   */
  _playSfx(buffer, opts = {}) {
    const ctx = audioContext;
    if (!ctx || !buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = typeof opts.playbackRate === 'number' ? opts.playbackRate : 1;
    const gain = ctx.createGain();
    gain.gain.value = typeof opts.gain === 'number' ? opts.gain : 1;
    if (opts.swapStereo) {
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      src.connect(splitter);
      splitter.connect(merger, 0, 1);
      splitter.connect(merger, 1, 0);
      merger.connect(gain);
    } else {
      src.connect(gain);
    }
    if (this._masterGain) gain.connect(this._masterGain);
    else gain.connect(ctx.destination);
    void ctx.resume().then(() => {
      try {
        src.onended = () => {
          if (typeof opts.onEnded === 'function') opts.onEnded();
        };
        src.start();
      } catch {
        /* */
      }
    });
  }

  /**
   * @param {unknown} detail
   */
  _onObjectAmbient(detail) {
    if (this._gameOverWorldMuted) return;
    const ctx = audioContext;
    const ra = audioEngine.resonanceAudio;
    if (!ctx || !ra || !detail || typeof detail !== 'object') return;

    const raw = /** @type {{ objects?: unknown }} */ (detail).objects;
    if (!Array.isArray(raw)) return;

    /** @type {Map<string, { cell: string; soundKey: string; objectType: string | null; x: number; y: number }>} */
    const next = new Map();
    for (const o of raw) {
      if (!o || typeof o !== 'object') continue;
      const ob = /** @type {Record<string, unknown>} */ (o);
      if (typeof ob.id !== 'string') continue;
      const g = gridFromDetail(ob);
      if (!g) continue;
      const objectType = typeof ob.type === 'string' ? ob.type : null;
      const soundKey =
        typeof ob.soundKey === 'string' && ob.soundKey in URLS.ambient ? ob.soundKey : 'default';
      next.set(ob.id, {
        cell: formatCell(g.x, g.y),
        soundKey,
        objectType,
        x: g.x,
        y: g.y,
      });
    }

    for (const [id, src] of this._ambientById) {
      if (!next.has(id)) {
        src.stop();
        this._directionalSources.delete(src);
        this._ambientById.delete(id);
      }
    }

    for (const id of this._objectTimedAmbientByInstanceId.keys()) {
      if (!next.has(id)) {
        this._objectTimedAmbientByInstanceId.delete(id);
      }
    }

    for (const [id, spec] of next) {
      const objectType = spec.objectType;
      const regAmb = objectType ? this._objectAmbientBufferByTypeId.get(objectType) : null;

      const ambGain = objectType
        ? registryGainFromSounds(this._objectSoundsByTypeId.get(objectType), 'ambient')
        : 1;

      if (objectType && this._objectUsesTimedAmbientOnly(objectType)) {
        if (!regAmb) continue;
        const loopSrc = this._ambientById.get(id);
        if (loopSrc) {
          loopSrc.stop();
          this._directionalSources.delete(loopSrc);
          this._ambientById.delete(id);
        }
        const prev = this._objectTimedAmbientByInstanceId.get(id);
        if (prev && prev.objectType === objectType) {
          prev.x = spec.x;
          prev.y = spec.y;
        } else {
          this._objectTimedAmbientByInstanceId.set(id, {
            anchorMs: performance.now(),
            x: spec.x,
            y: spec.y,
            objectType,
          });
        }
        continue;
      }

      const ambBuf = regAmb ?? this._ambientBuffers[spec.soundKey] ?? this._ambientBuffers.default;
      if (!ambBuf) continue;

      this._objectTimedAmbientByInstanceId.delete(id);

      let src = this._ambientById.get(id);
      if (!src) {
        src = new SpatialSource({
          audioContext: ctx,
          resonanceAudio: ra,
          cell: spec.cell,
          soundBuffer: ambBuf,
          loop: true,
          baseVolume: ambGain,
        });
        this._ambientById.set(id, src);
        this._directionalSources.add(src);
        void audioContext?.resume().then(() => src?.play());
      } else {
        src.setPosition(spec.cell);
        src.setSoundBuffer(ambBuf);
        src.setBaseVolume(ambGain);
      }
    }

    this._refreshAllDirectional();
  }

  /**
   * When objects become movable: spatial one-shot at grid cell. Uses `move_sound`, then `ambient_sound`.
   * @param {number} gridX
   * @param {number} gridY
   * @param {string} objectTypeId Registry object id
   */
  playObjectMoveOneShotAt(gridX, gridY, objectTypeId) {
    if (this._gameOverWorldMuted) return;
    const buf =
      this._objectMoveBufferByTypeId.get(objectTypeId) ??
      this._objectAmbientBufferByTypeId.get(objectTypeId);
    if (!buf) return;
    const gv = registryGainFromSounds(this._objectSoundsByTypeId.get(objectTypeId), 'ambient');
    this._playSpatialOneShot(gridX, gridY, buf, { gain: gv });
  }

  /**
   * Non-looping spatial SFX at a grid cell (Resonance source + directional filter vs listener / gyro).
   * @param {number} gridX
   * @param {number} gridY
   * @param {AudioBuffer} buffer
   * @param {{ gain?: number; onEnded?: (() => void) | null }} [opts]
   * @returns {SpatialSource | null}
   */
  _playSpatialOneShot(gridX, gridY, buffer, opts = {}) {
    const ctx = audioContext;
    const ra = audioEngine.resonanceAudio;
    if (!ctx || !ra || !buffer) return null;
    const gain = typeof opts.gain === 'number' ? opts.gain : 1;
    const src = new SpatialSource({
      audioContext: ctx,
      resonanceAudio: ra,
      cell: formatCell(gridX, gridY),
      soundBuffer: buffer,
      loop: false,
      baseVolume: gain,
    });
    this._worldOneShotSources.add(src);
    src.onPlaybackEnded = () => {
      this._directionalSources.delete(src);
      this._worldOneShotSources.delete(src);
      if (typeof opts.onEnded === 'function') opts.onEnded();
      src.onPlaybackEnded = null;
    };
    this._directionalSources.add(src);
    src.updateDirectionalFilter(playerAudioGrid, this._headingForSpatial());
    // Guard: if this source was removed from _worldOneShotSources before the audio context
    // resumes (e.g. first_entry aura or death clears it synchronously before this microtask
    // runs), skip play() entirely so the cancelled sound never starts.
    void ctx.resume().then(() => {
      if (this._worldOneShotSources.has(src)) src.play();
    });
    return src;
  }

  /**
   * @param {unknown} detail
   * `creatures[]` (legacy) or `{ id, pos, creatureTypeId }` from {@link GameLoop} / {@link Creature}.
   */
  _onCreatureTick(detail) {
    if (this._deathInProgress || this._gameOverWorldMuted) return;
    const ctx = audioContext;
    const ra = audioEngine.resonanceAudio;
    if (!ctx || !ra || !detail || typeof detail !== 'object') return;

    const d = /** @type {Record<string, unknown>} */ (detail);

    /** @type {{ id: string; x: number; y: number; soundKey?: string; creatureTypeId?: string }[]} */
    const list = [];

    if (Array.isArray(d.creatures)) {
      for (const c of d.creatures) {
        if (!c || typeof c !== 'object') continue;
        const cr = /** @type {Record<string, unknown>} */ (c);
        if (typeof cr.id !== 'string') continue;
        const g = gridFromDetail(cr);
        if (!g) continue;
        const ck =
          typeof cr.soundKey === 'string' && cr.soundKey in URLS.creature ? cr.soundKey : 'default';
        list.push({ id: cr.id, x: g.x, y: g.y, soundKey: ck });
      }
    } else if (typeof d.id === 'string' && d.pos && typeof d.pos === 'object') {
      const pos = /** @type {{ x?: unknown; y?: unknown }} */ (d.pos);
      if (typeof pos.x === 'number' && typeof pos.y === 'number') {
        const creatureTypeId = typeof d.creatureTypeId === 'string' ? d.creatureTypeId : '';
        list.push({ id: d.id, x: pos.x, y: pos.y, creatureTypeId });
      }
    }

    if (list.length === 0) return;

    const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
    const seen = new Set();
    const suppressCreatureAudio = this._isCreatureAudioSuppressed();

    for (const item of list) {
      seen.add(item.id);
      const cell = formatCell(item.x, item.y);

      let cBuf = null;
      if (typeof item.soundKey === 'string') {
        cBuf = this._creatureBuffers[item.soundKey] ?? this._creatureBuffers.default;
      } else if (item.creatureTypeId) {
        cBuf =
          this._creatureAmbientByTypeId.get(item.creatureTypeId) ??
          this._creatureBuffers.default ??
          null;
        if (this._creatureUsesTimedAmbientOnly(item.creatureTypeId)) cBuf = null;
      } else {
        cBuf = this._creatureBuffers.default ?? null;
      }
      // Kill collision frame: suppress creature loop audio so kill_sound is exclusive.
      if (item.x === playerAudioGrid.x && item.y === playerAudioGrid.y) cBuf = null;
      if (suppressCreatureAudio) cBuf = null;

      const audible = cBuf != null;
      const buf = cBuf ?? silent;

      const creatureGain =
        typeof item.creatureTypeId === 'string' && item.creatureTypeId
          ? (this._creatureVolumeByTypeId.get(item.creatureTypeId) ?? 1)
          : 1;
      const loopVol = audible ? creatureGain : 0;

      let src = this._creatureById.get(item.id);
      if (!src) {
        src = new SpatialSource({
          audioContext: ctx,
          resonanceAudio: ra,
          cell,
          soundBuffer: buf,
          loop: true,
          baseVolume: loopVol,
        });
        this._creatureById.set(item.id, src);
        this._directionalSources.add(src);
        if (audible) void audioContext?.resume().then(() => src?.play());
      } else {
        src.setPosition(cell);
        src.setSoundBuffer(buf);
        src.setVolume(loopVol);
        if (audible) {
          if (!src.playing) void audioContext?.resume().then(() => src.play());
        } else {
          src.stop();
        }
      }

      const sg = this._stalkerIdleGaspById.get(item.id);
      if (sg) {
        sg.x = item.x;
        sg.y = item.y;
      }

      if (item.creatureTypeId) {
        this._knownCreaturePositions.set(item.id, {
          x: item.x,
          y: item.y,
          creatureTypeId: item.creatureTypeId,
        });
      }
    }

    this._checkCreatureAuras(playerAudioGrid.x, playerAudioGrid.y);

    for (const [id, src] of this._creatureById) {
      if (!seen.has(id)) {
        src.stop();
        this._directionalSources.delete(src);
        this._creatureById.delete(id);
      }
    }

    this._refreshAllDirectional();
  }

  /**
   * Check all tracked creatures with an aura sound against the given player tile.
   * Plays the aura one-shot on entry into range; resets the flag on exit.
   * @param {number} px Player grid x
   * @param {number} py Player grid y
   */
  _checkCreatureAuras(px, py) {
    if (this._deathInProgress || this._gameOverWorldMuted) return;
    for (const [instanceId, pos] of this._knownCreaturePositions) {
      const { creatureTypeId } = pos;
      // Kill collision frame: aura cues are suppressed; only kill_sound should play.
      if (pos.x === px && pos.y === py) continue;
      const auraBuf = this._creatureAuraSoundByTypeId.get(creatureTypeId);
      if (!auraBuf) continue;
      const auraDist = this._creatureAuraDistanceByTypeId.get(creatureTypeId) ?? 1;
      const chebyshev = Math.max(Math.abs(pos.x - px), Math.abs(pos.y - py));
      const inRange = chebyshev <= auraDist;
      const wasInRange = this._creatureAuraActiveIds.has(instanceId);
      if (inRange && !wasInRange) {
        this._creatureAuraActiveIds.add(instanceId);
        const auraVol = this._creatureAuraVolumeByTypeId.get(creatureTypeId) ?? 1;
        if (!this._creatureAuraFirstEntryFiredIds.has(instanceId)) {
          this._creatureAuraFirstEntryFiredIds.add(instanceId);
          const firstBuf = this._creatureAuraFirstEntrySoundByTypeId.get(creatureTypeId);
          if (firstBuf) {
            const now = performance.now();
            this._creatureAuraPriorityUntilMs = Math.max(
              this._creatureAuraPriorityUntilMs,
              now + firstBuf.duration * 1000,
            );
            this._stopCreatureLoopSources();
            // Wipe every in-flight world one-shot (ambient gasps, move cues from all creatures)
            // so aura_sound_first_entry + aura_sound play in complete isolation.
            for (const s of this._worldOneShotSources) {
              s.stop();
              this._directionalSources.delete(s);
            }
            this._worldOneShotSources.clear();
            this._stalkerMoveOneShotById.clear();
            this._playSpatialOneShot(pos.x, pos.y, firstBuf, { gain: auraVol });
          } else {
            // No first_entry buffer configured; fall back to stopping only this creature's move cue.
            const moveSrc = this._stalkerMoveOneShotById.get(instanceId);
            if (moveSrc) {
              moveSrc.stop();
              this._directionalSources.delete(moveSrc);
              this._stalkerMoveOneShotById.delete(instanceId);
            }
          }
        } else {
          // Re-entry after first_entry has already fired: suppress only this creature's move cue.
          const moveSrc = this._stalkerMoveOneShotById.get(instanceId);
          if (moveSrc) {
            moveSrc.stop();
            this._directionalSources.delete(moveSrc);
            this._stalkerMoveOneShotById.delete(instanceId);
          }
        }
        this._playSpatialOneShot(pos.x, pos.y, auraBuf, { gain: auraVol });
      } else if (!inRange) {
        this._creatureAuraActiveIds.delete(instanceId);
      }
    }
  }

  _onPlayerDeath(detail) {
    if (this._deathInProgress) return;
    this._deathInProgress = true;

    // Wipe all world spatial sources first so kill_sound plays in isolation —
    // no aura/move/ambient one-shots from prior ticks bleed into the death frame.
    this._clearSpatialWorldSources();
    this._onStalkerIdleClear();

    const killerTypeId =
      detail && typeof detail === 'object' && typeof /** @type {{ creatureTypeId?: unknown }} */ (detail).creatureTypeId === 'string'
        ? /** @type {{ creatureTypeId: string }} */ (detail).creatureTypeId
        : null;
    if (killerTypeId) {
      const killBuf = this._creatureKillSoundByTypeId.get(killerTypeId);
      if (killBuf) {
        const killGain = this._creatureKillSoundVolumeByTypeId.get(killerTypeId) ?? 1;
        this._playSfx(killBuf, { gain: killGain });
      }
    }

    this._rampMasterGain(0, MASTER_FADE_S);

    const ctx = audioContext;
    const buf = this._buffers.death;
    const gDeath = this._deathDirectGain;
    if (ctx && buf && gDeath) {
      try {
        this._deathDirectSource?.stop();
      } catch {
        /* */
      }
      this._deathDirectSource?.disconnect();
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gDeath);
      gDeath.gain.cancelScheduledValues(t);
      gDeath.gain.setValueAtTime(1, t);
      src.onended = () => {
        if (this._deathDirectSource === src) this._deathDirectSource = null;
      };
      this._deathDirectSource = src;
      void ctx.resume().then(() => {
        try {
          src.start(t);
        } catch {
          /* */
        }
      });
    }

    if (this._deathResetTimer) clearTimeout(this._deathResetTimer);
    this._deathResetTimer = setTimeout(() => {
      this._deathResetTimer = null;
      gameEvents.emit('RESET_GAME');
    }, DEATH_RESET_DELAY_S * 1000);
  }

  _onStalkerIdleClear() {
    for (const src of this._stalkerMoveOneShotById.values()) {
      src.stop();
      this._directionalSources.delete(src);
    }
    this._stalkerMoveOneShotById.clear();
    this._stalkerIdleGaspById.clear();
    this._objectTimedAmbientByInstanceId.clear();
    this._creatureAuraActiveIds.clear();
    this._creatureAuraFirstEntryFiredIds.clear();
    this._creatureAuraPriorityUntilMs = 0;
    this._knownCreaturePositions.clear();
  }

  /**
   * @param {unknown} detail
   */
  _onStalkerSpawned(detail) {
    if (this._gameOverWorldMuted) return;
    if (!detail || typeof detail !== 'object') return;
    const d = /** @type {{ id?: unknown; x?: unknown; y?: unknown; creatureTypeId?: unknown }} */ (detail);
    if (typeof d.id !== 'string') return;
    const x = typeof d.x === 'number' && Number.isFinite(d.x) ? d.x : 0;
    const y = typeof d.y === 'number' && Number.isFinite(d.y) ? d.y : 0;
    const creatureTypeId =
      typeof d.creatureTypeId === 'string' && d.creatureTypeId ? d.creatureTypeId : 'stalker';
    this._stalkerIdleGaspById.set(d.id, { anchorMs: performance.now(), x, y, creatureTypeId });
  }

  /**
   * @param {unknown} detail
   */
  _onStalkerMove(detail) {
    if (this._gameOverWorldMuted) return;
    if (!detail || typeof detail !== 'object') return;
    const d = /** @type {{ id?: unknown; x?: unknown; y?: unknown; creatureTypeId?: unknown }} */ (detail);
    if (typeof d.id !== 'string') return;
    const st = this._stalkerIdleGaspById.get(d.id);
    if (!st) return;

    st.anchorMs = performance.now();

    if (typeof d.x === 'number' && typeof d.y === 'number') {
      st.x = d.x;
      st.y = d.y;
    }

    const typeId =
      (typeof d.creatureTypeId === 'string' && d.creatureTypeId
        ? d.creatureTypeId
        : st.creatureTypeId) ?? 'stalker';
    // On kill collision, suppress move cue so death kill_sound is the only creature cue.
    if (st.x === playerAudioGrid.x && st.y === playerAudioGrid.y) return;
    // STALKER_MOVE can arrive just before CREATURE_TICK triggers first-entry aura logic.
    // If this move places the creature inside aura range and first-entry hasn't fired yet,
    // skip move audio so the first-entry cue has priority.
    if (!this._creatureAuraFirstEntryFiredIds.has(d.id)) {
      const firstEntryBuf = this._creatureAuraFirstEntrySoundByTypeId.get(typeId);
      if (firstEntryBuf) {
        const auraDist = this._creatureAuraDistanceByTypeId.get(typeId) ?? 1;
        const chebyshev = Math.max(Math.abs(st.x - playerAudioGrid.x), Math.abs(st.y - playerAudioGrid.y));
        if (chebyshev <= auraDist) return;
      }
    }
    if (this._isCreatureAudioSuppressed()) return;
    const buf =
      this._creatureMoveSoundByTypeId.get(typeId) ?? this._creatureAmbientByTypeId.get(typeId);
    if (buf) {
      const gv = 0.85 * (this._creatureVolumeByTypeId.get(typeId) ?? 1);
      const prev = this._stalkerMoveOneShotById.get(d.id);
      if (prev) {
        prev.stop();
        this._directionalSources.delete(prev);
        this._stalkerMoveOneShotById.delete(d.id);
      }
      const moveSrc = this._playSpatialOneShot(st.x, st.y, buf, {
        gain: gv,
        onEnded: () => {
          this._stalkerMoveOneShotById.delete(d.id);
        },
      });
      if (moveSrc) this._stalkerMoveOneShotById.set(d.id, moveSrc);
    }
  }

  _tickTimedAmbients() {
    if (!this._busInitialized || this._deathInProgress || this._gameOverWorldMuted) return;
    const now = performance.now();
    if (!this._isCreatureAudioSuppressed()) {
      for (const [, st] of this._stalkerIdleGaspById) {
        const typeId = st.creatureTypeId ?? 'stalker';
        const buf = this._creatureAmbientByTypeId.get(typeId);
        if (!buf) continue;
        const sec = this._creatureAmbientTimerSecByTypeId.get(typeId);
        const idleMs =
          typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 10000;
        if (now - st.anchorMs < idleMs) continue;
        st.anchorMs = now;
        const gv = 0.85 * (this._creatureVolumeByTypeId.get(typeId) ?? 1);
        this._playSpatialOneShot(st.x, st.y, buf, { gain: gv });
      }
    }
    for (const [, st] of this._objectTimedAmbientByInstanceId) {
      const typeId = st.objectType;
      const buf = this._objectAmbientBufferByTypeId.get(typeId);
      if (!buf) continue;
      const sec = this._objectAmbientTimerSecByTypeId.get(typeId);
      const idleMs =
        typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 10000;
      if (now - st.anchorMs < idleMs) continue;
      st.anchorMs = now;
      const gv = registryGainFromSounds(this._objectSoundsByTypeId.get(typeId), 'ambient');
      this._playSpatialOneShot(st.x, st.y, buf, { gain: gv });
    }
  }

  _onResetGame() {
    if (this._deathResetTimer) {
      clearTimeout(this._deathResetTimer);
      this._deathResetTimer = null;
    }
    this._deathInProgress = false;

    this._stalkerIdleGaspById.clear();
    this._creatureAuraActiveIds.clear();
    this._creatureAuraFirstEntryFiredIds.clear();
    this._creatureAuraPriorityUntilMs = 0;
    this._knownCreaturePositions.clear();

    this._rampMasterGain(1, RAMP_TAIL_S);

    this._clearSpatialWorldSources();

    if (this._deathDirectSource) {
      try {
        this._deathDirectSource.stop();
      } catch {
        /* */
      }
      this._deathDirectSource.disconnect();
      this._deathDirectSource = null;
    }
  }

  startBgMusic() {
    this._wantBgMusic = true;
    this._wantLandingMusic = false;
    this._wantGameOverMusic = false;
    const ctx = audioContext;
    const buffer = this._sfxBuffers.backroomsBgMusic;
    if (!ctx || !buffer || this._bgMusicSource) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.4, now + MUSIC_FADE_S);
    src.connect(gain);
    if (this._masterGain) gain.connect(this._masterGain);
    else gain.connect(ctx.destination);

    src.onended = () => {
      if (this._bgMusicSource === src) {
        this._bgMusicSource = null;
        this._bgMusicGain = null;
      }
    };

    this._bgMusicSource = src;
    this._bgMusicGain = gain;
    void ctx.resume().then(() => {
      try {
        src.start();
      } catch {
        /* */
      }
    });
  }

  stopBgMusic() {
    this._wantBgMusic = false;
    const ctx = audioContext;
    const source = this._bgMusicSource;
    const gain = this._bgMusicGain;
    if (!source || !gain || !ctx) return;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + MUSIC_FADE_S);
    const sourceToStop = source;
    const gainToDisconnect = gain;
    setTimeout(() => {
      try {
        sourceToStop.stop();
      } catch {
        /* */
      }
      sourceToStop.disconnect();
      gainToDisconnect.disconnect();
    }, Math.ceil((MUSIC_FADE_S + 0.05) * 1000));
    this._bgMusicSource = null;
    this._bgMusicGain = null;
  }

  startLandingMusic() {
    this.stopGameOverMusic();
    this._wantLandingMusic = true;
    this._wantBgMusic = false;
    this._wantGameOverMusic = false;
    const ctx = audioContext;
    const buffer = this._sfxBuffers.landingPageMusic;
    if (!ctx || !buffer || this._landingMusicSource) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.5, now + MUSIC_FADE_S);
    src.connect(gain);
    if (this._masterGain) gain.connect(this._masterGain);
    else gain.connect(ctx.destination);

    src.onended = () => {
      if (this._landingMusicSource === src) {
        this._landingMusicSource = null;
        this._landingMusicGain = null;
      }
    };

    this._landingMusicSource = src;
    this._landingMusicGain = gain;
    void ctx.resume().then(() => {
      try {
        src.start();
      } catch {
        /* */
      }
    });
  }

  stopLandingMusic() {
    this._wantLandingMusic = false;
    const ctx = audioContext;
    const source = this._landingMusicSource;
    const gain = this._landingMusicGain;
    if (!source || !gain || !ctx) return;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + MUSIC_FADE_S);
    const sourceToStop = source;
    const gainToDisconnect = gain;
    setTimeout(() => {
      try {
        sourceToStop.stop();
      } catch {
        /* */
      }
      sourceToStop.disconnect();
      gainToDisconnect.disconnect();
    }, Math.ceil((MUSIC_FADE_S + 0.05) * 1000));
    this._landingMusicSource = null;
    this._landingMusicGain = null;
  }

  /**
   * Looping background for the game-over screen (`public/assets/sfx/charlie-kirk.mp3`).
   * Call when the final level is cleared and the game-over UI is shown (not on every `LEVEL_EXITED`).
   */
  startGameOverMusic() {
    this._wantGameOverMusic = true;
    this._wantBgMusic = false;
    this._wantLandingMusic = false;
    const ctx = audioContext;
    const buffer = this._sfxBuffers.gameOverMusic;
    if (!ctx || !buffer || this._gameOverMusicSource) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.1, now + MUSIC_FADE_S);
    src.connect(gain);
    if (this._masterGain) gain.connect(this._masterGain);
    else gain.connect(ctx.destination);

    src.onended = () => {
      if (this._gameOverMusicSource === src) {
        this._gameOverMusicSource = null;
        this._gameOverMusicGain = null;
      }
    };

    this._gameOverMusicSource = src;
    this._gameOverMusicGain = gain;
    void ctx.resume().then(() => {
      try {
        src.start();
      } catch {
        /* */
      }
    });
  }

  /**
   * Stops spatial world audio (creatures, object loops, ambients) while the game-over UI is visible.
   * Level reload after death still runs; this prevents new world SFX until {@link resumeWorldAudioAfterGameOver}.
   */
  suspendWorldAudioForGameOver() {
    this._gameOverWorldMuted = true;
    this._clearSpatialWorldSources();
    this._onStalkerIdleClear();
  }

  resumeWorldAudioAfterGameOver() {
    this._gameOverWorldMuted = false;
  }

  stopGameOverMusic() {
    this._wantGameOverMusic = false;
    const ctx = audioContext;
    const source = this._gameOverMusicSource;
    const gain = this._gameOverMusicGain;
    if (!source || !gain || !ctx) return;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + MUSIC_FADE_S);
    const sourceToStop = source;
    const gainToDisconnect = gain;
    setTimeout(() => {
      try {
        sourceToStop.stop();
      } catch {
        /* */
      }
      sourceToStop.disconnect();
      gainToDisconnect.disconnect();
    }, Math.ceil((MUSIC_FADE_S + 0.05) * 1000));
    this._gameOverMusicSource = null;
    this._gameOverMusicGain = null;
  }

  stopAllMusic() {
    this.stopBgMusic();
    this.stopLandingMusic();
    this.stopGameOverMusic();
  }

  stopBgMusicImmediate() {
    if (!this._bgMusicSource) return;
    try {
      this._bgMusicSource.stop();
    } catch {
      /* */
    }
    this._bgMusicSource.disconnect();
    this._bgMusicSource = null;
    if (this._bgMusicGain) {
      this._bgMusicGain.disconnect();
      this._bgMusicGain = null;
    }
  }

  /**
   * During aura first-entry cue playback, non-aura creature sounds are temporarily muted.
   * @returns {boolean}
   */
  _isCreatureAudioSuppressed() {
    return performance.now() < this._creatureAuraPriorityUntilMs;
  }

  _stopCreatureLoopSources() {
    for (const src of this._creatureById.values()) {
      src.stop();
      this._directionalSources.delete(src);
    }
  }
}

export const audioEventBus = new AudioEventBus();
