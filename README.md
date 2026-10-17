# Logic-Rhythm

[

![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)

](https://aaronvandorn.github.io/Logic-Rhythm/)

**[▶ Try it live](https://aaronvandorn.github.io/Logic-Rhythm/)**

Served over HTTPS via GitHub Pages, so Web MIDI permissions work out of the box in supported browsers (Chrome/Edge) — no extra setup needed.

A logic gate-sequenced drum machine prototype

I have had an idea for a drum machine that worked with logic gates for a while, and getting access to an AI client at work and using it for a couple things lead me to think that maybe that would be something I could do with it.  So I started vibe-coding it with Claude, and this has been the result.  I think it's a fun thing to play with, but I wondered if there was something I could do to flesh it out, and as part of that, I thought I'd solicit feedback on it.  Feel free to play with the file (it's just and html page) and leave any feedback/suggestions/requests in the discussion section. 

Overview:

This is a drum machine inspired by logic gates.  Each voice has an A and B input clock, and between them sits a logic gate (and, or, xor, nor, etc), and a series of clocks that can be set to different pulses and be offset.  You can add clocks as well, so you could, for example, have one clock going at 1 pulse per beat and a second at 11 beats and put an AND gate between them, and then you'd get a hit directly on the 11th 16th note of the measure.  You can select the sound per voice, and you can "nudge" the beats per voices from the strict logic.  There's also a velocity and swing control that increases or decreases both of those parameters per voice.

There's also a universal LFO with a selectable waveform that can be selected to impact the timing and offset of the clocks as well as the velocity and swing of the individual voices.  When activated, the sliders on velocity and swing act as attenuators on the LFO.

In addition, there's a single clock "accent" clock with a division and offset.  So for example, you could have it set for 12 beats and offset it to a single beat, or three beats and offset that across the measure.  Each voice has an A button that turns on the accent for that voice.

Finally, the major controls are all midi controllable, and the machine can learn the midi control you want on the fly.

I think that's the most of it.  I am really interested to hear what people think, and what you think could be done to make it more interesting, more fun, and/or more musical.  

Thanks for checking it out! -- Aaron

## Percussion kit

Alongside the drum kit there's a second set of synthesized sounds: traditional hand drums, bells, wood and shakers (conga, tumba, conga slap, bongos, djembe bass and tone, surdo, talking drum, tabla, timbale, cowbell, agogo, triangle, clave, woodblock, shaker, cabasa, tambourine, guiro). Every slot's sound dropdown lists them under **Percussion**.

The **Kit** selector in the top bar switches all seven slots between **Drum Kit** and **Percussion** at once. Only the sounds change; the clocks and gates stay the same, so any pattern can be heard as a percussion ensemble. Each slot remembers the sound it had on the other side, so switching back returns anything you picked by hand. Mixing kit and percussion sounds is fine; the selector then reads **Mixed**.

Three new patterns in the library are set up for it: **Percussion 12/8** (the Afrobeat pattern as a hand-drum ensemble with the bell on agogo), **Percussion 3 over 4** (tumba playing 3 against cowbell playing 4, with the conga slap only where they disagree), and **Percussion Polyrhythm** (the odd-numbered clocks of Pure Polyrhythm on pitched drums and bells).

## Record & export

The **Export** bar under the transport saves the rack as WAV and/or MIDI. The MIDI file has one track per rack row, with General MIDI drum notes on channel 10 (kick 36, snare 38, closed hat 42 and so on), so it drops straight onto a DAW drum kit. Bars follow the grid's meter: 3/4 for the waltz grids, 4/4 otherwise.

While the app's sound is on, the last 48 seconds of what it plays (audio and notes) are kept in memory. **Save last N** takes what just played; **Record next N** starts recording now. With a bar grid running it works in bars (1 to 16), cut on exact bar lines so takes loop seamlessly; otherwise in seconds (5 to 45). Tick **WAV** for exactly what you heard, **MIDI** for the notes, or both for one .zip with the two files. Nothing is uploaded. This comes from the shared `jam-clips.js` module (the `JAM-CLIPS` block in `index.html`), which every app in the set uses.

## Jam Link

Press **Link** in this app and in Logic Rhythm, Boolean Melody Machine and Choir (open each in its own tab or window of the same browser) and they share tempo, start/stop, key and mode, and saved scenes, all locked to one beat grid. **Create room** or **Join** with a short code to do the same with people in other places, and hear each other's apps. See [JAM-LINK.md](JAM-LINK.md) for how it works.

Notes for this app: the tempo slider now runs 40–240 BPM so it matches the others, and a tempo change while running now keeps the steps evenly spaced.

## Discobot guest

This app can be a unit in the rack of [Discobot](https://iw978599.github.io/discobot/), a browser sequencer and drum machine. In Discobot choose **Project → Add Guest Instrument** and paste `https://aaronvandorn.github.io/Logic-Rhythm/`. Discobot then starts and stops the app on its beat, sets the tempo, takes its sound into its mixer, and saves its settings with the project. Opened on its own, the app is unchanged. See [JAM-LINK.md](JAM-LINK.md#discobot-guest) for details.
