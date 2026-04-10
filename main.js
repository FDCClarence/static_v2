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

const gameScreen = new GameScreen();
const gameOverScreen = new GameOverScreen();

const inputManager = new InputManager();
inputManager.init();
audioEngine.init();
void audioEventBus.init({ inputManager });

const landingPage = new LandingPage();
landingPage.onStart = async () => {
  landingPage.hide();
  gameOverScreen.hide();
  gameScreen.show();
  currentLevelIndex = 0;
  await startLevel(currentLevelIndex);
};

gameOverScreen.onBackToLanding = () => {
  gameOverScreen.hide();
  gameScreen.hide();
  landingPage.show();
};

gameEvents.on('LEVEL_EXITED', async () => {
  const nextLevelIndex = currentLevelIndex + 1;
  if (nextLevelIndex >= LEVEL_IDS.length) {
    gameScreen.hide();
    gameOverScreen.show();
    return;
  }
  currentLevelIndex = nextLevelIndex;
  await startLevel(currentLevelIndex);
});

const permissionScreen = new PermissionScreen();
permissionScreen.onGranted = () => {
  inputManager.attachSensorsAfterUserGesture();
  permissionScreen.hide();
  gameScreen.show();
  landingPage.show();
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
  gridEngine.loadLevel(levelData);

  const keyObject = Array.isArray(levelData.objects)
    ? levelData.objects.find((obj) => obj && obj.type === 'key' && typeof obj.cell === 'string')
    : null;
  if (!keyObject) return;
  const keyCell = parseCell(keyObject.cell);
  audioEngine.createStaticSource(keyCell.x, keyCell.y);
}
