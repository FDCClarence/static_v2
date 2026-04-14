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
      ambient_sound: 'ghost-1.mp3',
      ambient_timer: 20,
      move_sound: 'stalk-breathing.wav',
    },
  },
];
