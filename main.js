import { StaticOverlay } from './src/ui/StaticOverlay.js';
import { audioEngine } from './src/audio/AudioEngine.js';
import { audioEventBus, playerAudioGrid } from './src/audio/AudioEventBus.js';
import './src/audio/SpatialSource.js';
import './src/audio/ReverbZones.js';
import { gridEngine, parseCell } from './src/engine/GridEngine.js';
import { gameLoop, resolveRandomCreatureSpawns } from './src/engine/GameLoop.js';
import './src/engine/EventEmitter.js';
import { InputManager } from './src/engine/InputManager.js';
import './src/entities/Player.js';
import './src/entities/Creature.js';
import './src/entities/ObjectEntity.js';
import './src/entities/behaviors/StalkBehavior.js';
import './src/entities/behaviors/DeceptiveBehavior.js';
import './src/entities/behaviors/GuardBehavior.js';
import './src/entities/behaviors/AmbushBehavior.js';
import { GameScreen } from './src/ui/GameScreen.js';
import { PermissionScreen } from './src/ui/PermissionScreen.js';
import { LandingPage } from './src/ui/LandingPage.js';
import { GameOverScreen } from './src/ui/GameOverScreen.js';
import { gameEvents } from './src/engine/EventEmitter.js';

const LEVEL_IDS = ['level_01'];
const levelDataByIdPromise = loadAllLevelData(LEVEL_IDS);
/** One spatial world-loop slot: key cell → door cell after unlock (see registry `ambient_sound`). */
const LEVEL_OBJECT_WORLD_LOOP_ID = 'level-object-world-loop';
let currentLevelIndex = 0;
/** After door unlock, `KEY_COLLECTED` must not stop the new door loop. */
let suppressKeyCollectWorldStop = false;

const gameScreen = new GameScreen();
const gameOverScreen = new GameOverScreen();

const inputManager = new InputManager();
inputManager.init();
audioEngine.init();
void audioEventBus.init({ inputManager });

const landingPage = new LandingPage();
landingPage.onStart = async () => {
  audioEventBus.stopGameOverMusic();
  audioEventBus.resumeWorldAudioAfterGameOver();
  audioEventBus.stopLandingMusic();
  landingPage.hide();
  gameOverScreen.hide();
  gameScreen.show();
  audioEventBus.startBgMusic();
  currentLevelIndex = 0;
  await startLevel(currentLevelIndex);
  const allLevels = await levelDataByIdPromise;
  const levelId = LEVEL_IDS[currentLevelIndex];
  const levelData = levelId ? allLevels[levelId] : null;
  const lockedDoor = Array.isArray(levelData?.objects)
    ? levelData.objects.find((obj) => obj && obj.type === 'door-locked' && typeof obj.cell === 'string')
    : null;
  const playerStartCell =
    levelData && typeof levelData === 'object' && levelData.playerStart && typeof levelData.playerStart === 'object'
      ? levelData.playerStart.cell
      : null;
  if (typeof playerStartCell === 'string') {
    const spawn = parseCell(playerStartCell);
    playerAudioGrid.x = spawn.x;
    playerAudioGrid.y = spawn.y;
    audioEngine.setListenerTransform(playerAudioGrid, inputManager.smoothedHeading);
  }
  if (lockedDoor?.cell) {
    audioEventBus.playBeginCueAtCell(lockedDoor.cell);
  }
};

gameOverScreen.onBackToLanding = () => {
  audioEventBus.stopBgMusic();
  audioEventBus.resumeWorldAudioAfterGameOver();
  audioEventBus.startLandingMusic();
  gameOverScreen.hide();
  gameScreen.hide();
  landingPage.show();
};

gameEvents.on('LEVEL_EXITED', async () => {
  suppressKeyCollectWorldStop = false;
  const nextLevelIndex = currentLevelIndex + 1;
  if (nextLevelIndex >= LEVEL_IDS.length) {
    audioEventBus.stopBgMusic();
    audioEventBus.suspendWorldAudioForGameOver();
    audioEventBus.startGameOverMusic();
    gameScreen.hide();
    gameOverScreen.show('escaped');
    return;
  }
  currentLevelIndex = nextLevelIndex;
  await startLevel(currentLevelIndex);
});

gameEvents.on('PLAYER_DEATH', () => {
  audioEventBus.stopBgMusic();
  audioEventBus.suspendWorldAudioForGameOver();
  gameScreen.hide();
  gameOverScreen.show('died');
});

gameEvents.on('KEY_COLLECTED', () => {
  if (suppressKeyCollectWorldStop) {
    suppressKeyCollectWorldStop = false;
    return;
  }
  audioEventBus.stopWorldAmbientLoop(LEVEL_OBJECT_WORLD_LOOP_ID);
});

gameEvents.on('DOOR_UNLOCKED', (detail) => {
  if (!detail || typeof detail !== 'object') return;
  const d = /** @type {{ x?: unknown; y?: unknown; playerX?: unknown; playerY?: unknown }} */ (detail);
  // Emitted before PLAYER_MOVED; keep listener grid aligned with the pickup step.
  if (typeof d.playerX === 'number' && typeof d.playerY === 'number') {
    playerAudioGrid.x = d.playerX;
    playerAudioGrid.y = d.playerY;
  }
  if (typeof d.x === 'number' && typeof d.y === 'number') {
    suppressKeyCollectWorldStop = true;
    audioEventBus.playRegistryObjectWorldLoop(LEVEL_OBJECT_WORLD_LOOP_ID, d.x, d.y, 'door-unlocked');
  }
  audioEventBus.syncSpatialAudio(inputManager.heading);
});

const permissionScreen = new PermissionScreen();
permissionScreen.onGranted = () => {
  inputManager.attachSensorsAfterUserGesture();
  permissionScreen.hide();
  StaticOverlay.mount();
  gameScreen.show();
  landingPage.show();
  audioEventBus.startLandingMusic();
};
permissionScreen.show();

function resizeCanvas() {
  gameScreen.syncCanvasSize();
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

/**
 * @param {string[]} levelIds
 */
async function loadLevelData(levelIds) {
  const levelDataById = {};
  for (const levelId of levelIds) {
    const levelUrl = new URL(`./src/data/levels/${levelId}.json`, import.meta.url);
    const res = await fetch(levelUrl, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Failed to load level data (${levelId}): ${res.status}`);
    }
    levelDataById[levelId] = await res.json();
  }
  return levelDataById;
}

/**
 * @param {string[]} levelIds
 */
async function loadAllLevelData(levelIds) {
  return loadLevelData(levelIds);
}

/**
 * @param {number} levelIndex
 */
async function startLevel(levelIndex) {
  const levelId = LEVEL_IDS[levelIndex];
  if (!levelId) return;
  inputManager.calibrateNorthForLevelStart();
  const allLevels = await levelDataByIdPromise;
  const baseLevelData = allLevels[levelId];
  if (!baseLevelData) return;
  // Use a fresh copy each run because random creature spawn resolution mutates `creatures[].cell`.
  const levelData = JSON.parse(JSON.stringify(baseLevelData));
  audioEventBus.clearWorldAmbientLoops();
  suppressKeyCollectWorldStop = false;
  resolveRandomCreatureSpawns(levelData);
  gridEngine.loadLevel(levelData);
  gameLoop.onLevelLoading(levelData);

  const ps = levelData.playerStart;
  const playerStartCell =
    ps && typeof ps === 'object' && typeof /** @type {{ cell?: unknown }} */ (ps).cell === 'string'
      ? /** @type {{ cell: string }} */ (ps).cell
      : null;
  if (typeof playerStartCell === 'string') {
    const spawn = parseCell(playerStartCell);
    playerAudioGrid.x = spawn.x;
    playerAudioGrid.y = spawn.y;
    audioEngine.setListenerTransform(playerAudioGrid, inputManager.smoothedHeading);
  }

  const keyObject = Array.isArray(levelData.objects)
    ? levelData.objects.find((obj) => obj && obj.type === 'key' && typeof obj.cell === 'string')
    : null;
  if (keyObject) {
    const keyCell = parseCell(keyObject.cell);
    audioEventBus.playRegistryObjectWorldLoop(LEVEL_OBJECT_WORLD_LOOP_ID, keyCell.x, keyCell.y, 'key');
  }
}

gameLoop.setReloadHandler(async () => {
  await startLevel(currentLevelIndex);
});
