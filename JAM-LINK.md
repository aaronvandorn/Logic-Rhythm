# Jam Link

Logic Rhythm, Boolean Melody Machine and Choir can play together. Each app has a **Jam Link** tab at the bottom of the page; click it to open the dock (Link / Online / Scenes). Press **Link** in every app you want in the jam and they share tempo, start/stop, key and mode, and saved scenes. An app that is not linked is left alone.

## Using it

1. Open the apps in separate tabs or windows of the same browser. Side by side in separate windows is best, because browsers slow down timers in tabs you cannot see (a tab that is making sound is normally exempt).
2. Press **Link** in each one. The Online box lists the other apps it can see.
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

## Online: playing with people in other places

Each person runs one app on their own computer. One of you presses **Create room** and shares the short code (or **Copy link**, which opens the app straight into the room). The others type the code and press **Join**, or open the link in whichever app they are playing. Up to 8 apps can be in a room.

Once you are in, everything above works across the room: tempo, start/stop, key and mode, and scenes. You also **hear each other's apps**. Each app sends a copy of its own output to everyone else, and each person gets a volume slider and a Mute button for every other app, plus the round-trip delay to them. Anyone with the code can listen in, so only share it with people you mean to, and press **Leave** when you are done.

Notes:

- **Time zones for clocks.** Computers' clocks disagree, so each link measures the difference and converts, and all the apps agree on when each beat happens (a test with one clock 5 seconds off agreed within a millisecond on the same machine).
- **What you hear is delayed.** Your own app is on the grid in your headphones, and the others arrive late by the network delay, usually 30–150 ms. Each person's playing is still in time with the group; it is the monitoring that lags. Wired connections and headphones help (speakers can feed back into nothing here, since no microphone is used). Use Sync trim if you want to line your own app up with what arrives.
- **Connection.** Rooms are set up through the free public PeerJS broker (`0.peerjs.com`), after which the apps talk directly to each other. Very restrictive networks (some offices and schools) can block that. If you want your own broker, set `window.JAM_PEER_OPTIONS` before the page loads.
- Your other tabs in the same browser stay linked locally. Join the room from each tab that should take part.
- `peerjs.min.js` (the PeerJS 1.5.4 client, MIT licence) sits next to each `index.html` and has to be uploaded with it.

## How it works

Each tab has its own audio clock, so the shared timeline lives on the wall clock (`performance.timeOrigin + performance.now()`). A transport is a list of tempo segments, `bpm`, `anchorWall` and `anchorBeat`, so beat *b* happens at a known wall time. Each app turns that into its own AudioContext time with `getOutputTimestamp()` and schedules its notes on beats. Messages travel over a `BroadcastChannel`, so every app must be served from the same origin (they are, on `aaronvandorn.github.io`).

The module is the same block of code in all three files, between `JAM-LINK:BEGIN` and `JAM-LINK:END`; `jam-link.js` is the source copy.

## Limits

- Without a room, it works across tabs and windows of one browser on one computer. Use a room to reach other browsers and other computers.
- The apps stay in step on the beat grid. Anything that loops against a different length, like Choir's motif, keeps its own length and simply stays on the beat.
- The scheduling maths is tested to be exact. How closely the three outputs line up in real time depends on the browser's audio timestamps, usually within a few milliseconds. Use Sync trim to fine-tune.
