# Jam Link

Logic Rhythm, Boolean Melody Machine and Choir can play together. Each app has a **Jam link** panel. Press **Link** in every app you want in the jam and they share tempo, start/stop, key and mode, and saved scenes. An app that is not linked is left alone.

## Using it

1. Open the apps in separate tabs or windows of the same browser. Side by side in separate windows is best, because browsers slow down timers in tabs you cannot see (a tab that is making sound is normally exempt).
2. Press **Link** in each one. The panel lists the other apps it can see.
3. Press play in any linked app. The others start with it, locked to the same beat grid.
4. Change the tempo anywhere and everything follows. Tempo changes take effect about 150 ms later so every app switches on the same beat.

An app that starts while the others are already playing (Link on, Start/stop on, then you press play) comes in on the next bar line. Pressing stop in any linked app stops them all. To keep one app out of the start/stop, untick **Start / stop** in it, and it will keep playing or staying silent on its own.

The checkboxes are per app and remembered:

- **Tempo** follow and send tempo
- **Start / stop** follow and send transport
- **Key & mode** (Melody Machine and Choir) share root and mode. Modes the other app does not have (Blues, Harmonic Minor, Chromatic) leave that app's mode alone and share only the root.
- **Scenes** take part in scene capture and recall

**Sync trim** nudges one app earlier or later (±80 ms) if it sounds a touch off the others, for example because one is routed to a Bluetooth speaker.

## Scenes

**Save scene** asks every linked app for its current pattern and stores them together, with tempo and key. Clicking a scene recalls every app's pattern at once, and sets the tempo and key. Scenes are stored in the browser (shared by all three apps) and each app lists them.

## How it works

Each tab has its own audio clock, so the shared timeline lives on the wall clock (`performance.timeOrigin + performance.now()`). A transport is a list of tempo segments, `bpm`, `anchorWall` and `anchorBeat`, so beat *b* happens at a known wall time. Each app turns that into its own AudioContext time with `getOutputTimestamp()` and schedules its notes on beats. Messages travel over a `BroadcastChannel`, so every app must be served from the same origin (they are, on `aaronvandorn.github.io`).

The module is the same block of code in all three files, between `JAM-LINK:BEGIN` and `JAM-LINK:END`; `jam-link.js` is the source copy.

## Limits

- It works across tabs and windows of one browser on one computer. It does not reach other browsers or other devices.
- The apps stay in step on the beat grid. Anything that loops against a different length, like Choir's motif, keeps its own length and simply stays on the beat.
- The scheduling maths is tested to be exact. How closely the three outputs line up in real time depends on the browser's audio timestamps, usually within a few milliseconds. Use Sync trim to fine-tune.
