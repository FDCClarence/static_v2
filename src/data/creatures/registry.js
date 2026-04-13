/** Creature definitions (plain JS so unbundled static hosts e.g. GitHub Pages can load as ES modules). */
export default [
  {
    id: 'stalker',
    volume: 0.35,
    speed: 3,
    hearingRadius: 6,
    behavior: 'stalk',
    devLabel: 'STK',
    sounds: {
      ambient_sound: 'stalk-breathing.wav',
      ambient_timer: 3,
      move_sound: 'zombie-gasp.wav',
    },
  },
];
