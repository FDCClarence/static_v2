/**
 * Subscribes to game events and drives spatial audio + master bus.
 */
import { audioContext, audioEngine } from './AudioEngine.js';
import { SpatialSource } from './SpatialSource.js';
import { gameEvents } from '../engine/EventEmitter.js';
import { formatCell, parseCell } from '../engine/GridEngine.js';

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
  ambient: {
    default: assetUrl('ambient_default.wav'),
  },
  creature: {
    default: assetUrl('creature_default.wav'),
  },
};
const SFX_FILES = {
  walkingWood: 'walking-wood.mp3',
  keyGrab: 'key-grab.mp3',
  keySound: 'key-sound.mp3',
  doorBump: 'door-bump.mp3',
  attemptOpenLockedDoor: 'attempt-open-locked-door.mp3',
  openDoorWithKey: 'open-door-with-key.mp3',
  wallBump: 'wall-bump.mp3',
  backroomsBgMusic: 'backrooms-bg-music.mp3',
  landingPageMusic: 'landing-page-music.mp3',
  gameOverMusic: 'charlie-kirk.mp3',
};
const MUSIC_FADE_S = 0.8;

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
    /** @type {Map<string, { source: SpatialSource; fadeOutSec: number }>} Spatial world loops (registry `worldLoop`). */
    this._worldAmbientLoopsById = new Map();
    /** @type {Map<string, Record<string, unknown>>} Object `sounds` from registry, keyed by object type id. */
    this._objectSoundsByTypeId = new Map();

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
    /** @type {Record<string, AudioBuffer | null>} */
    this._sfxBuffers = {
      walkingWood: null,
      keyGrab: null,
      keySound: null,
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

    await this._loadBuffers();
    this._createOneShotSources();
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
   * Register ambient asset URLs from object registry (`sounds.ambient` → `audio/<id>.wav`).
   */
  async _registerObjectAmbientUrlsFromRegistry() {
    const registryUrl = new URL('../data/objects/registry.json', import.meta.url);
    try {
      const res = await fetch(registryUrl);
      if (!res.ok) return;
      const reg = await res.json();
      if (!Array.isArray(reg)) return;
      for (const obj of reg) {
        if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string') continue;
        const sounds = obj.sounds;
        this._objectSoundsByTypeId.set(obj.id, sounds && typeof sounds === 'object' ? sounds : {});
        if (!sounds || typeof sounds !== 'object') continue;
        const amb = sounds.ambient;
        if (typeof amb === 'string' && amb && !(amb in URLS.ambient)) {
          URLS.ambient[amb] = assetUrl(`${amb}.wav`);
        }
      }
    } catch {
      /* registry optional at dev time */
    }
  }

  /**
   * @param {string} objectTypeId Registry object id (e.g. `key`, `door-unlocked`).
   * @returns {string | null} `sounds.ambient` id when present.
   */
  getObjectAmbientSoundKey(objectTypeId) {
    const sounds = this._objectSoundsByTypeId.get(objectTypeId);
    const k = sounds && typeof sounds === 'object' ? sounds.ambient : null;
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
   * @param {string} objectTypeId
   * @returns {{ sfxKey: string; fadeInSec: number; fadeOutSec: number; gain: number } | null}
   */
  getObjectWorldLoopConfig(objectTypeId) {
    const sounds = this._objectSoundsByTypeId.get(objectTypeId);
    if (!sounds || typeof sounds !== 'object') return null;
    const sfxKey = sounds.worldLoop;
    if (typeof sfxKey !== 'string' || !sfxKey) return null;
    return {
      sfxKey,
      fadeInSec: typeof sounds.worldLoopFadeInSec === 'number' ? sounds.worldLoopFadeInSec : 0,
      fadeOutSec: typeof sounds.worldLoopFadeOutSec === 'number' ? sounds.worldLoopFadeOutSec : 0,
      gain: registryGainFromSounds(sounds, 'worldLoop'),
    };
  }

  /**
   * Spatial looping SFX at a grid cell (`public/assets/sfx`), fades from registry.
   * @param {string} trackId
   * @param {number} gridX
   * @param {number} gridY
   * @param {string} registryObjectTypeId e.g. `key`, `door-unlocked`
   */
  playRegistryObjectWorldLoop(trackId, gridX, gridY, registryObjectTypeId) {
    const cfg = this.getObjectWorldLoopConfig(registryObjectTypeId);
    if (!cfg) return;
    const buf = this._sfxBuffers[cfg.sfxKey];
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
    await this._registerObjectAmbientUrlsFromRegistry();
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

    const sfxBase = await resolveSfxBase();
    await Promise.all(
      Object.entries(SFX_FILES).map(async ([key, file]) => {
        this._sfxBuffers[key] = await decodeUrl(ctx, sfxUrl(sfxBase, file));
      }),
    );

    // On slower networks (e.g. GH Pages), music start may be requested before large files decode.
    if (this._wantBgMusic) this.startBgMusic();
    if (this._wantLandingMusic) this.startLandingMusic();
    if (this._wantGameOverMusic) this.startGameOverMusic();
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
    if (detail && typeof detail === 'object') {
      const objectType = /** @type {{ objectType?: unknown }} */ (detail).objectType;
      if (objectType === 'door-locked') {
        const lockedSfx = this._sfxBuffers.attemptOpenLockedDoor;
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
    const sfx = this._sfxBuffers.keyGrab;
    if (sfx) {
      this._playSfx(sfx, { gain: this.getRegistrySoundGain('key', 'interact') });
    }
  }

  _onLevelExited() {
    this._clearSpatialWorldSources();
    const sfx = this._sfxBuffers.openDoorWithKey;
    if (sfx) {
      const rg = this.getRegistrySoundGain('door-unlocked', 'interact');
      this._playSfx(sfx, { gain: 1.5 * rg, swapStereo: true });
    }
  }

  /** Stop looping world spatial audio (level hunt cues, object ambients, creatures, engine spatial loops). */
  _clearSpatialWorldSources() {
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
    };
    this._directionalSources.add(src);
    src.updateDirectionalFilter(playerAudioGrid, this._headingForSpatial());
    void ctx.resume().then(() => src.play());
  }

  /**
   * @param {AudioBuffer} buffer
   * @param {{ gain?: number; playbackRate?: number; swapStereo?: boolean }} [opts]
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
    const ctx = audioContext;
    const ra = audioEngine.resonanceAudio;
    if (!ctx || !ra || !detail || typeof detail !== 'object') return;

    const raw = /** @type {{ objects?: unknown }} */ (detail).objects;
    if (!Array.isArray(raw)) return;

    /** @type {Map<string, { cell: string; soundKey: string; objectType: string | null }>} */
    const next = new Map();
    for (const o of raw) {
      if (!o || typeof o !== 'object') continue;
      const ob = /** @type {Record<string, unknown>} */ (o);
      if (typeof ob.id !== 'string') continue;
      const g = gridFromDetail(ob);
      if (!g) continue;
      const soundKey =
        typeof ob.soundKey === 'string' && ob.soundKey in URLS.ambient ? ob.soundKey : 'default';
      const objectType = typeof ob.type === 'string' ? ob.type : null;
      next.set(ob.id, { cell: formatCell(g.x, g.y), soundKey, objectType });
    }

    for (const [id, src] of this._ambientById) {
      if (!next.has(id)) {
        src.stop();
        this._directionalSources.delete(src);
        this._ambientById.delete(id);
      }
    }

    for (const [id, spec] of next) {
      let src = this._ambientById.get(id);
      const ambBuf = this._ambientBuffers[spec.soundKey] ?? this._ambientBuffers.default;
      if (!ambBuf) continue;

      const ambGain = spec.objectType
        ? registryGainFromSounds(this._objectSoundsByTypeId.get(spec.objectType), 'ambient')
        : 1;

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
   * @param {unknown} detail
   */
  _onCreatureTick(detail) {
    const raw = detail && typeof detail === 'object' ? /** @type {{ creatures?: unknown }} */ (detail).creatures : null;
    if (!Array.isArray(raw)) return;

    const ctx = audioContext;
    const ra = audioEngine.resonanceAudio;
    if (!ctx || !ra) return;

    const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
    const seen = new Set();
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      const cr = /** @type {Record<string, unknown>} */ (c);
      if (typeof cr.id !== 'string') continue;
      const g = gridFromDetail(cr);
      if (!g) continue;
      seen.add(cr.id);
      const cell = formatCell(g.x, g.y);
      const ck =
        typeof cr.soundKey === 'string' && cr.soundKey in URLS.creature ? cr.soundKey : 'default';
      const cBuf = this._creatureBuffers[ck] ?? this._creatureBuffers.default;
      const audible = cBuf != null;
      const buf = cBuf ?? silent;
      let src = this._creatureById.get(cr.id);
      if (!src) {
        src = new SpatialSource({
          audioContext: ctx,
          resonanceAudio: ra,
          cell,
          soundBuffer: buf,
          loop: true,
          baseVolume: audible ? 1 : 0,
        });
        this._creatureById.set(cr.id, src);
        this._directionalSources.add(src);
        if (audible) void audioContext?.resume().then(() => src?.play());
      } else {
        src.setPosition(cell);
        src.setSoundBuffer(buf);
        src.setVolume(audible ? 1 : 0);
        if (audible) {
          if (!src.playing) void audioContext?.resume().then(() => src.play());
        } else {
          src.stop();
        }
      }
    }

    for (const [id, src] of this._creatureById) {
      if (!seen.has(id)) {
        src.stop();
        this._directionalSources.delete(src);
        this._creatureById.delete(id);
      }
    }

    this._refreshAllDirectional();
  }

  _onPlayerDeath() {
    if (this._deathInProgress) return;
    this._deathInProgress = true;

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

  _onResetGame() {
    if (this._deathResetTimer) {
      clearTimeout(this._deathResetTimer);
      this._deathResetTimer = null;
    }
    this._deathInProgress = false;

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
    gain.gain.linearRampToValueAtTime(0.5, now + MUSIC_FADE_S);
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
}

export const audioEventBus = new AudioEventBus();
