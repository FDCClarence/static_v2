import { audioEngine } from './src/audio/AudioEngine.js';
import { audioEventBus } from './src/audio/AudioEventBus.js';
import './src/audio/SpatialSource.js';
import './src/audio/ReverbZones.js';
import { gridEngine, parseCell } from './src/engine/GridEngine.js';
import './src/engine/GameLoop.js';
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
let currentLevelIndex = 0;
let activeKeyStaticSource = null;
let transferredStaticToDoorOnPickup = false;

const gameScreen = new GameScreen();
const gameOverScreen = new GameOverScreen();

const inputManager = new InputManager();
inputManager.init();
audioEngine.init();
void audioEventBus.init({ inputManager });

const landingPage = new LandingPage();
landingPage.onStart = async () => {
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
  if (lockedDoor?.cell) {
    audioEventBus.playBeginCueAtCell(lockedDoor.cell);
  }
};

gameOverScreen.onBackToLanding = () => {
  audioEventBus.stopBgMusic();
  audioEventBus.startLandingMusic();
  gameOverScreen.hide();
  gameScreen.hide();
  landingPage.show();
};

gameEvents.on('LEVEL_EXITED', async () => {
  const nextLevelIndex = currentLevelIndex + 1;
  if (nextLevelIndex >= LEVEL_IDS.length) {
    audioEventBus.stopBgMusic();
    gameScreen.hide();
    gameOverScreen.show();
    return;
  }
  currentLevelIndex = nextLevelIndex;
  await startLevel(currentLevelIndex);
});

gameEvents.on('KEY_COLLECTED', () => {
  if (transferredStaticToDoorOnPickup) {
    transferredStaticToDoorOnPickup = false;
    return;
  }
  audioEngine.removeStaticSource(activeKeyStaticSource);
  activeKeyStaticSource = null;
});

gameEvents.on('DOOR_UNLOCKED', (detail) => {
  if (!detail || typeof detail !== 'object') return;
  const d = /** @type {{ x?: unknown; y?: unknown }} */ (detail);
  if (typeof d.x !== 'number' || typeof d.y !== 'number') return;
  transferredStaticToDoorOnPickup = true;
  audioEngine.removeStaticSource(activeKeyStaticSource);
  activeKeyStaticSource = audioEngine.createStaticSource(d.x, d.y);
});

const permissionScreen = new PermissionScreen();
permissionScreen.onGranted = () => {
  inputManager.attachSensorsAfterUserGesture();
  permissionScreen.hide();
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
  const levelData = allLevels[levelId];
  if (!levelData) return;
  audioEngine.clearStaticSources();
  transferredStaticToDoorOnPickup = false;
  activeKeyStaticSource = null;
  gridEngine.loadLevel(levelData);

  const keyObject = Array.isArray(levelData.objects)
    ? levelData.objects.find((obj) => obj && obj.type === 'key' && typeof obj.cell === 'string')
    : null;
  if (!keyObject) return;
  const keyCell = parseCell(keyObject.cell);
  activeKeyStaticSource = audioEngine.createStaticSource(keyCell.x, keyCell.y);
}
