# More Blindly Obese 1 : The Game — audio-first blind horror grid game

**More Blindly Obese 1 : The Game** is a horror game where you can't see anything.
You're trapped in a room with monsters. No map, no flashlight — just sound. Voices, footsteps, scraping. The monsters are out there, and you can hear where they are if you listen carefully enough. Rotate your phone to turn, swipe to move. Find the key. Find the door. Get out before something finds you first.
Built for headphones. Best played alone, in the dark.

------

A small browser game where you navigate an invisible tile grid using **spatial 3D audio** and a **compass**. There is no map on screen: walls, objects, creatures, and goals are understood by **listening** and by how the compass reacts. The experience is built for **headphones** and, on phones, **device orientation** (compass heading).

This repository is a **vanilla JavaScript** prototype (Vite for dev/build, [Resonance Audio](https://resonance-audio.github.io/resonance-audio/) for HRTF and room modeling, JSON data for levels).

---

## What you are doing

You play as someone moving one step at a time on an **8-direction grid** (including diagonals). The shipped level (`level_01`) is a simple maze: **find the key**, which **unlocks the door**, then **step onto the opened door tile** to finish the run. A **stalker** creature roams according to level data (with a random floor spawn so each run is slightly different).

- **Death**: stepping into the same tile as a hostile creature ends the run.
- **Success**: exiting through the unlocked door shows an escape-style end screen (there is currently one level in the build; clearing it ends the session).

---

## How it feels to play

1. **Sound is the world** — Keys, doors, creatures, and bumps are positioned in 3D space around you. Turning your head (or the phone) changes how those sounds arrive, so you can tell **where** things are relative to your facing.
2. **The compass is your HUD** — A minimal on-screen compass shows your **snapped facing** (N, NE, E, …). It also warns you when stepping **forward** would hit a wall, a creature, or similar danger (visual emphasis and, on supported devices, **vibration** when the forward tile is outright hostile).
3. **North resets per level** — When a level starts, your **current device heading is treated as “north”** for that run, so you do not need to align the real world to the map; you care about **relative** rotation while playing.
4. **Diagonal movement “slides”** — If you try to move diagonally into a corner blocked only by a wall or the map edge, the engine may **slide** you along one cardinal direction instead (first horizontal, then vertical), so diagonals still feel usable in tight spaces.

There is also a **TV static–style overlay** for atmosphere after permissions are granted.

---

## Controls

### Phone (intended experience)

| Action | Input |
|--------|--------|
| **Turn / choose facing** | **Rotate the device** — compass heading is smoothed and snapped to **8 compass directions**. |
| **Step forward** (in the direction you face) | **Swipe up** — short vertical gesture, within time/distance thresholds. |
| **Step backward** (opposite of facing) | **Swipe down** — same idea as forward, downward. |

Use **headphones**. The first screen asks for **audio context** and **motion/orientation** access where the browser requires it (notably iOS).

### Desktop / no gyro (development builds only)

When you run `npm run dev`, open the site on **localhost**, or add `?dev=1` to the URL, **keyboard controls** simulate heading and movement (see `InputManager.js`):

| Action | Keys |
|--------|------|
| **Nudge heading** | **Arrow Left/Right**, **A/D**, or **,/.** — adjusts compass in small steps (no physical gyro). |
| **Step forward** | **W** |
| **Step backward** | **S** |

### Developer grid overlay (same dev conditions as above)

A **DEV MODE** panel can show a **toggle** that draws the grid, entities, and labels for debugging. This is hidden in production builds.

---

## Flow through the app

1. **Permission screen** — Unlocks Web Audio and requests orientation (and related motion permission where needed).
2. **Game shell** — Compass and canvas mount; **landing** copy explains the gist (“rotate phone”, “swipe up to move”, “creatures”, “follow the sounds”, “headphones”).
3. **BEGIN** — Loads the level, starts spatial/world audio, and may play a short cue toward the locked door.
4. **Play** — Black stage + compass; you navigate by audio and touch/motion (or dev keys).
5. **Game over** — Death or escape returns a full-screen outcome with a path back to the landing flow.

---

## Run it locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (use **HTTPS or localhost** if you test device sensors on a phone). Production bundle:

```bash
npm run build
npm run preview
```

---

## Content and code layout (high level)

- **Levels**: `src/data/levels/*.json` — grid, player start, objects, creatures, reverb preset, etc.
- **Objects / creatures**: `src/data/objects/registry.js`, `src/data/creatures/registry.js` — definitions drive audio and grid behavior.
- **Rooms**: `src/data/rooms/presets.json` — reverb / room presets for Resonance.
- **Engine**: `src/engine/` — grid, input, game loop, events.
- **Audio**: `src/audio/` — engine wrapper, spatial sources, event-driven cues.

Adding levels, objects, or creatures is intended to be mostly **data-driven** without rewriting the core engine.

---

## Archival note

This README is written as a **snapshot** of how the game behaves and is controlled in the codebase at archive time. If you pick the project up again later, start from `main.js` (boot flow), `InputManager.js` (controls), and `GridEngine.js` (rules of movement and win/loss).
