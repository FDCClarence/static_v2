/** Creature definitions (plain JS so unbundled static hosts e.g. GitHub Pages can load as ES modules). */
export default [
  {
    id: 'stalker',
    volume: 1,
    speed: 3,
    hearingRadius: 6,
    behavior: 'stalk',
    devLabel: 'STK',
    sounds: {
      ambient_sound: 'minecraft-zombie.mp3',
      ambient_timer: 12,
      move_sound: 'minecraft-zombie.mp3',
    },
  },
];
