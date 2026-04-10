import { audioEngine, audioContext } from './src/audio/AudioEngine.js';
import { audioEventBus } from './src/audio/AudioEventBus.js';
import './src/audio/SpatialSource.js';
import './src/audio/ReverbZones.js';
import './src/engine/GridEngine.js';
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

const gameScreen = new GameScreen();

const inputManager = new InputManager();
inputManager.init();
audioEngine.init();
void audioEventBus.init({ inputManager });

const landingPage = new LandingPage();
landingPage.onStart = () => {
  landingPage.hide();
  void beginFromUserGesture();
};

const permissionScreen = new PermissionScreen();
permissionScreen.onGranted = () => {
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

async function beginFromUserGesture() {
  await inputManager.requestPermission();
  await audioContext?.resume().catch(() => {});
}
