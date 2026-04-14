/** Creature definitions (plain JS so unbundled static hosts e.g. GitHub Pages can load as ES modules). */
export default [
  {
    id: 'stalker',
    volume: 1,
    speed: 4,
    hearingRadius: 6,
    behavior: 'stalk',
    devLabel: 'STK',
    aura_sound_distance: 1,
    aura_sound_volume: 1,
    sounds: {
      ambient_sound: 'ghost-1.mp3',
      ambient_timer: 10,
      move_sound: 'stalk-breathing.wav',
      aura_sound: 'goosebumps.mp3',
      aura_sound_first_entry: 'ghost-i-see-you.mp3',
      kill_sound: 'fah.mp3',
      kill_sound_volume: 1,
    },
  },
];
