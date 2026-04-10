import './src/audio/AudioEngine.js';
import './src/audio/SpatialSource.js';
import './src/audio/AudioEventBus.js';
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
import './src/ui/GameScreen.js';
import './src/ui/DevOverlay.js';
import { PermissionScreen } from './src/ui/PermissionScreen.js';
import { LandingPage } from './src/ui/LandingPage.js';

const canvas = document.getElementById('game');

const inputManager = new InputManager();
inputManager.init();

const landingPage = new LandingPage();
landingPage.onStart = () => {
  landingPage.hide();
  void beginFromUserGesture();
};

const permissionScreen = new PermissionScreen();
permissionScreen.onGranted = () => {
  permissionScreen.hide();
  landingPage.show();
};
permissionScreen.show();

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

async function beginFromUserGesture() {
  await inputManager.requestPermission();
}
