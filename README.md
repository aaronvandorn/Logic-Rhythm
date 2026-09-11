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
