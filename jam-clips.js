/* ===== JAM CLIPS — capture, export and clips for every app in the ecosystem =====
   One identical copy of this block is embedded in each app (between the JAM-CLIPS markers);
   jam-clips.js is the source copy. Every new app should include it and call JamClips.source().

   What a source app gets:
     - A rolling recording of its own output (the last KEEP_SEC seconds) through an AudioWorklet
       tap, plus a rolling log of the notes and controller moves it played.
     - EXPORT: an Export bar (mount()) that saves the last N bars, or records the next N bars, as a
       WAV file (exactly what was heard), a MIDI file (one track per voice), or both in one .zip.
       With no bar grid running it works in seconds instead.
     - CLIPS: Tape Loop Deck (a *receiver*) can ask any source for bar-exact clips over a
       BroadcastChannel; they become looping tapes. Same browser, same origin only.

   The tap counts AudioContext frames and the app's bar grid is in AudioContext time too, so cuts
   land on exact bar lines: a 4-bar take is exactly 4 bars long and loops seamlessly.

   Wiring an app (see the README of any app for a full example):
     const jx = JamClips.source({
       app:'logic', title:'Logic Rhythm',
       ctx: () => audioContext,                 // the app's AudioContext (null until it exists)
       nodes: () => [masterOut],                // what to record: the final output, pre-speakers
       grid: { barAt(t), timeOfBar(k) },        // optional: bar number at ctx time t (null when
                                                //   stopped) and ctx time of bar k; or use barClock()
       bpm: () => 120, beatsPerBar: 4           // beatsPerBar may also be a function
     });
     jx.note(t, pitch, vel, dur, track, ch)     // a note with a known length (vel 1-127, ch 1-16)
     jx.hold(track, pitch, t, vel, ch)          // a held note on a track: replaces the track's
     jx.hold(track, null, t)                    //   sounding note; null releases it
     jx.release(t)                              // release every held note
     jx.cc(t, number, value, track, ch)         // controller automation
     jx.mount(element, { btn, primary, select })  // the Export bar, using the app's own classes

   Clip messages: { cv:1, from, t, ... } on channel CHANNEL, a different envelope from Jam Link's,
   so Jam Link never mistakes one for an app joining the jam.
     receiver -> all     rx        heartbeat
     source   -> all     src       heartbeat { app, title, playing, bpm, rec, keepSec }
     receiver -> source  req       { to, reqId, bars, mode: 'last' | 'next' }
     receiver -> source  cancel    { to, reqId }
     source   -> rx      status    { to, reqId, state: 'waiting' | 'error', msg, startsInMs, lengthSec }
     source   -> rx      clip      { to, reqId, sampleRate, left, right, bars, bpm, title, app }
     either   -> all     bye */
(function(global){
  'use strict';
  if(global.JamClips) return;
  var CHANNEL = 'aaronvandorn-clips-v1';
  var CV = 1;
  var HB_MS = 1500, TTL_MS = 5000, CHECK_MS = 500;
  var KEEP_SEC = 48;        // recent audio (and notes) each source keeps
  var MAX_BARS = 32;
  var BLOCK = 1024;
  var PPQ = 480;
  var BAR_CHOICES = [1, 2, 4, 8, 16], SEC_CHOICES = [5, 10, 20, 30, 45];
  var TAP_SRC = 'registerProcessor("jam-clip-tap", class extends AudioWorkletProcessor {' +
    'constructor(){ super(); this.l = new Float32Array(' + BLOCK + '); this.r = new Float32Array(' + BLOCK + '); this.n = 0; this.start = 0; }' +
    'process(inputs){ var input = inputs[0], a = input && input[0], b = input && (input[1] || input[0]);' +
    ' if(this.n === 0) this.start = currentFrame;' +
    // clamped to what the speakers can play, so the take sounds like what was heard
    ' for(var i = 0; i < 128; i++){ var x = a ? a[i] : 0, y = b ? b[i] : 0; this.l[this.n + i] = x > 1 ? 1 : x < -1 ? -1 : x; this.r[this.n + i] = y > 1 ? 1 : y < -1 ? -1 : y; }' +
    ' this.n += 128;' +
    ' if(this.n >= ' + BLOCK + '){ this.port.postMessage({ frame: this.start, l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);' +
    '  this.l = new Float32Array(' + BLOCK + '); this.r = new Float32Array(' + BLOCK + '); this.n = 0; }' +
    ' return true; } });';

  var registry = [];        // every source on this page (JamClips.sources(), handy in the console)
  var tapModules = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function tapModule(c){
    var p = tapModules && tapModules.get(c);
    if(!p){
      var url = URL.createObjectURL(new Blob([TAP_SRC], { type:'application/javascript' }));
      p = c.audioWorklet.addModule(url);
      if(tapModules) tapModules.set(c, p);
    }
    return p;
  }
  function rid(){ return Math.random().toString(36).slice(2, 10); }
  function now(){ return Date.now(); }
  function clampInt(v, a, b){ v = Math.round(Number(v)); return isFinite(v) ? Math.max(a, Math.min(b, v)) : a; }
  function openChannel(onMsg){
    if(typeof BroadcastChannel === 'undefined') return null;
    var ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = function(e){ var m = e.data; if(m && m.cv === CV && typeof m.t === 'string') onMsg(m); };
    return ch;
  }

  /* ---- file writers ---- */
  function wavBlob(L, R, sr){
    var n = L.length, bytes = n * 4, ab = new ArrayBuffer(44 + bytes), v = new DataView(ab);
    function ws(o, s){ for(var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    ws(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); ws(8, 'WAVE'); ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, bytes, true);
    for(var i = 0, o = 44; i < n; i++, o += 4){
      var a = Math.max(-1, Math.min(1, L[i])), b = Math.max(-1, Math.min(1, R[i]));
      v.setInt16(o, a < 0 ? a * 32768 : a * 32767, true); v.setInt16(o + 2, b < 0 ? b * 32768 : b * 32767, true);
    }
    return new Blob([ab], { type:'audio/wav' });
  }
  function vlq(n, out){
    var b = [n & 0x7f]; n >>= 7;
    while(n > 0){ b.unshift((n & 0x7f) | 0x80); n >>= 7; }
    for(var i = 0; i < b.length; i++) out.push(b[i]);
  }
  function textMeta(type, s, out){
    var u = unescape(encodeURIComponent(String(s).slice(0, 120)));
    out.push(0, 0xff, type); vlq(u.length, out); for(var i = 0; i < u.length; i++) out.push(u.charCodeAt(i) & 0xff);
  }
  function chunk(id, data){
    var out = [], i;
    for(i = 0; i < 4; i++) out.push(id.charCodeAt(i));
    out.push((data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255);
    for(i = 0; i < data.length; i++) out.push(data[i]);
    return out;
  }
  /* tracks: [{ name, events: [{ tick, order, bytes }] }] */
  function midiBlob(title, tracks, bpm, bpb){
    var head = [0, 1, ((tracks.length + 1) >> 8) & 255, (tracks.length + 1) & 255, (PPQ >> 8) & 255, PPQ & 255];
    var t0 = [];
    textMeta(0x03, title, t0);
    var us = Math.round(60000000 / (bpm || 120));
    t0.push(0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255);
    t0.push(0, 0xff, 0x58, 4, Math.max(1, Math.min(32, Math.round(bpb) || 4)), 2, 24, 8);
    t0.push(0, 0xff, 0x2f, 0);
    var bytes = chunk('MThd', head).concat(chunk('MTrk', t0));
    tracks.forEach(function(tr){
      var d = [];
      textMeta(0x03, tr.name, d);
      tr.events.sort(function(a, b){ return a.tick - b.tick || a.order - b.order; });
      var last = 0;
      tr.events.forEach(function(e){ vlq(Math.max(0, e.tick - last), d); last = Math.max(last, e.tick); for(var i = 0; i < e.bytes.length; i++) d.push(e.bytes[i]); });
      d.push(0, 0xff, 0x2f, 0);
      bytes = bytes.concat(chunk('MTrk', d));
    });
    return new Blob([new Uint8Array(bytes)], { type:'audio/midi' });
  }
  var CRC_T = null;
  function crc32(u){
    if(!CRC_T){ CRC_T = new Uint32Array(256); for(var n = 0; n < 256; n++){ var c = n; for(var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
    var c2 = 0xFFFFFFFF; for(var i = 0; i < u.length; i++) c2 = CRC_T[(c2 ^ u[i]) & 255] ^ (c2 >>> 8);
    return (c2 ^ 0xFFFFFFFF) >>> 0;
  }
  /* a stored (uncompressed) zip of [{ name, data: Uint8Array }] */
  function zipBlob(files){
    var parts = [], central = [], off = 0;
    function u16(v){ return [v & 255, (v >> 8) & 255]; }
    function u32(v){ return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function(f){
      var name = Array.prototype.map.call(unescape(encodeURIComponent(f.name)), function(ch){ return ch.charCodeAt(0); });
      var crc = crc32(f.data), size = f.data.length;
      var local = [0x50, 0x4b, 3, 4].concat(u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0), name);
      parts.push(new Uint8Array(local), f.data);
      central = central.concat([0x50, 0x4b, 1, 2], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name);
      off += local.length + size;
    });
    var end = [0x50, 0x4b, 5, 6].concat(u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(off), u16(0));
    parts.push(new Uint8Array(central), new Uint8Array(end));
    return new Blob(parts, { type:'application/zip' });
  }
  function download(blob, name){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 10000);
  }
  function slug(s){ return String(s || 'take').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'take'; }

  /* Bar grid for an app with its own clock. Call mark(ctxTime) on every bar line as it is scheduled
     and reset() when the clock restarts. Gives barAt / timeOfBar in AudioContext time. */
  function barClock(){
    var marks = [], n = 0;
    function lastDur(){ var L = marks.length; return L >= 2 ? marks[L-1].t - marks[L-2].t : 0; }
    return {
      mark: function(t){
        if(marks.length && t <= marks[marks.length-1].t + 1e-4) return;
        marks.push({ k: n++, t: t });
        if(marks.length > 512) marks.shift();
      },
      reset: function(){ marks = []; },
      barAt: function(t){
        var L = marks.length; if(L < 2) return null;
        if(t < marks[0].t) return null;
        for(var i = L - 1; i >= 0; i--){
          if(marks[i].t <= t){
            var nx = marks[i+1], d = nx ? nx.t - marks[i].t : lastDur();
            if(!nx && t > marks[i].t + 2.5 * d) return null;  // the clock has stopped
            return marks[i].k + (t - marks[i].t) / d;
          }
        }
        return null;
      },
      timeOfBar: function(k){
        for(var i = marks.length - 1; i >= 0; i--){ if(marks[i].k === k) return marks[i].t; if(marks[i].k < k) break; }
        return null;
      }
    };
  }

  /* ---- source: an app that records, exports and sends clips ---- */
  function source(o){
    var id = rid(), receivers = {}, rec = null, clipJob = null;
    var always = o.always !== false;          // false: record only while Tape Loop Deck is open
    var events = [], open = {};               // the note / controller log
    var ch = openChannel(onMessage);

    function bpb(){ var b = typeof o.beatsPerBar === 'function' ? o.beatsPerBar() : o.beatsPerBar; return b > 0 ? b : 4; }
    function bpmNow(){ try{ var b = o.bpm ? Number(o.bpm()) : 0; return b > 0 ? b : null; }catch(e){ return null; } }
    function post(m){ if(!ch) return; m.cv = CV; m.from = id; m.app = o.app; try{ ch.postMessage(m); }catch(e){} }
    function anyReceiver(){
      var t = now(), any = false;
      Object.keys(receivers).forEach(function(k){ if(t - receivers[k] < TTL_MS) any = true; else delete receivers[k]; });
      return any;
    }
    function ctx(){ try{ return o.ctx ? o.ctx() : null; }catch(e){ return null; } }
    function gridAt(t){ if(!o.grid) return null; try{ var b = o.grid.barAt(t); return b == null || !isFinite(b) ? null : b; }catch(e){ return null; } }
    function barTime(k){ try{ var t = o.grid.timeOfBar(k); return t == null || !isFinite(t) ? null : t; }catch(e){ return null; } }
    function playing(){ var c = ctx(); return !!(c && gridAt(c.currentTime) != null); }
    function check(){ if(always || anyReceiver()) ensureRec(); else stopRec(); trimLog(); }
    function heartbeat(){
      check();
      if(anyReceiver()){
        var b = bpmNow();
        post({ t:'src', title: o.title, playing: playing(), bpm: b ? Math.round(b * 10) / 10 : null, rec: !!(rec && rec.blocks.length), keepSec: KEEP_SEC });
      }
    }

    /* rolling recording */
    function ensureRec(){
      var c = ctx();
      if(!c || c.state !== 'running' || !c.audioWorklet || typeof AudioWorkletNode === 'undefined'){ if(rec && rec.ctx !== c) stopRec(); return; }
      if(rec && rec.ctx !== c) stopRec();
      if(!rec){
        rec = { ctx: c, node: null, blocks: [], starting: true };
        var r = rec;
        tapModule(c).then(function(){
          if(rec !== r) return;
          var node = new AudioWorkletNode(c, 'jam-clip-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          node.port.onmessage = function(ev){
            if(rec !== r) return;
            var d = ev.data;
            r.blocks.push({ f: d.frame, l: d.l, r: d.r });
            var keep = KEEP_SEC * c.sampleRate;
            while(r.blocks.length > 1 && r.blocks[0].f + BLOCK < d.frame - keep) r.blocks.shift();
          };
          node.connect(c.destination);           // outputs silence; this only keeps the tap running
          r.node = node; r.starting = false;
          connectNodes();
        }).catch(function(err){ if(rec === r) rec = null; if(global.console) console.warn('Jam Clips: could not start recording', err); });
      } else connectNodes();
    }
    function connectNodes(){
      if(!rec || !rec.node) return;
      var list = []; try{ list = (o.nodes && o.nodes()) || []; }catch(e){}
      list.forEach(function(n){ if(n && n.context === rec.ctx){ try{ n.connect(rec.node); }catch(e){} } });
    }
    function stopRec(){
      if(!rec) return;
      var r = rec; rec = null;
      if(r.node){
        var list = []; try{ list = (o.nodes && o.nodes()) || []; }catch(e){}
        list.forEach(function(n){ try{ n.disconnect(r.node); }catch(e){} });
        try{ r.node.port.onmessage = null; r.node.disconnect(); }catch(e){}
      }
    }
    function recSpan(){
      if(!rec || !rec.blocks.length) return null;
      var b = rec.blocks;
      return { f0: b[0].f, f1: b[b.length-1].f + BLOCK };
    }
    function extract(f0, f1){
      var span = recSpan(); if(!span || f0 < span.f0 || f1 > span.f1 || f1 <= f0) return null;
      var n = f1 - f0, L = new Float32Array(n), R = new Float32Array(n);
      rec.blocks.forEach(function(b){
        var a = Math.max(f0, b.f), z = Math.min(f1, b.f + BLOCK);
        if(z <= a) return;
        L.set(b.l.subarray(a - b.f, z - b.f), a - f0);
        R.set(b.r.subarray(a - b.f, z - b.f), a - f0);
      });
      return { left: L, right: R };
    }

    /* note / controller log (times are AudioContext seconds) */
    function trackKey(track, chn){ return String(track || 'Notes') + '\u0001' + (chn || 1); }
    function trimLog(){
      var c = ctx(); if(!c) return;
      var cut = c.currentTime - KEEP_SEC - 10;
      while(events.length && (events[0].end != null ? events[0].end : Infinity) < cut && events[0].t < cut) events.shift();
      if(events.length > 20000) events.splice(0, events.length - 20000);
    }
    function vel127(v){ v = Number(v); if(!isFinite(v)) return 100; if(v > 0 && v <= 1.0001 && v % 1 !== 0) v = v * 127; return clampInt(v, 1, 127); }
    function logNote(t, pitch, vel, dur, track, chn){
      if(!isFinite(t) || !isFinite(pitch)) return;
      events.push({ kind:'note', t: t, end: t + Math.max(0.005, Number(dur) || 0.1), pitch: clampInt(pitch, 0, 127), vel: vel127(vel), track: String(track || 'Notes'), ch: clampInt(chn || 1, 1, 16) });
    }
    function logHold(track, pitch, t, vel, chn){
      if(!isFinite(t)) return;
      var key = trackKey(track, chn), cur = open[key];
      if(cur){ cur.end = Math.max(cur.t + 0.005, t); delete open[key]; }
      if(pitch == null || !isFinite(pitch)) return;
      var e = { kind:'note', t: t, end: null, pitch: clampInt(pitch, 0, 127), vel: vel127(vel), track: String(track || 'Notes'), ch: clampInt(chn || 1, 1, 16) };
      events.push(e); open[key] = e;
    }
    function logRelease(t){ Object.keys(open).forEach(function(k){ var e = open[k]; e.end = Math.max(e.t + 0.005, t); }); open = {}; }
    function logCC(t, num, val, track, chn){
      if(!isFinite(t)) return;
      events.push({ kind:'cc', t: t, num: clampInt(num, 0, 127), val: clampInt(val, 0, 127), track: String(track || 'Controllers'), ch: clampInt(chn || 1, 1, 16) });
    }

    /* takes: { unit:'bars'|'sec', n, mode:'last'|'next' } -> { left, right, sr, t0, t1, bars, startBar, bpm } */
    var takeJobs = {};
    function take(spec, done, onWait){
      var jid = rid();
      var c = ctx();
      var unit = spec.unit === 'sec' ? 'sec' : 'bars';
      var n = unit === 'bars' ? clampInt(spec.n || 4, 1, MAX_BARS) : Math.max(1, Math.min(KEEP_SEC - 2, Number(spec.n) || 10));
      function fail(msg){ delete takeJobs[jid]; done(msg, null); }
      function finishAt(t0, t1, sb, eb){
        delete takeJobs[jid];
        var cc = rec && rec.ctx; if(!cc) return done('Lost the recording.', null);
        var sr = cc.sampleRate, data = extract(Math.round(t0 * sr), Math.round(t1 * sr));
        if(!data) return done('That audio is no longer in ' + o.title + '\'s recent recording.', null);
        var bars = sb != null ? eb - sb : null;
        var bpm = bars ? bars * bpb() * 60 / (t1 - t0) : bpmNow();
        done(null, { left: data.left, right: data.right, sr: sr, t0: t0, t1: t1, bars: bars, startBar: sb, bpm: bpm ? Math.round(bpm * 100) / 100 : null, unit: unit, n: bars || Math.round((t1 - t0) * 10) / 10 });
      }
      if(!c || c.state !== 'running') { fail(o.title + ' isn\'t making sound yet. Start it first.'); return jid; }
      ensureRec();
      if(spec.mode === 'last' && (!rec || rec.starting || !rec.blocks.length)){ fail('Recording has only just started. Let it play a little, or use Record next.'); return jid; }
      if(unit === 'bars'){
        var nowBar = gridAt(c.currentTime);
        if(nowBar == null){ fail(o.title + ' isn\'t playing. Press play first.'); return jid; }
        var barSec = 60 * bpb() / (bpmNow() || 120);
        if(n * barSec > KEEP_SEC - 2){ fail(n + ' bars is longer than ' + KEEP_SEC + ' seconds at this tempo. Choose fewer bars.'); return jid; }
        if(spec.mode === 'next'){
          var sb = Math.ceil(nowBar - 1e-6), eb = sb + n, startT = barTime(sb);
          if(onWait) onWait({ startsInMs: startT != null ? Math.max(0, Math.round((startT - c.currentTime) * 1000)) : null, lengthSec: Math.round(n * barSec * 10) / 10 });
          var deadline = now() + (n * barSec + 12) * 1000;
          takeJobs[jid] = setInterval(function(){
            var span = recSpan(), cc = ctx();
            if(!cc || gridAt(cc.currentTime) == null){ clearInterval(takeJobs[jid]); return fail(o.title + ' stopped before the bars were done.'); }
            if(span && rec && rec.ctx === cc){
              var endT = barTime(eb), st = barTime(sb);
              if(endT != null && st != null && span.f1 >= Math.round(endT * cc.sampleRate)){ clearInterval(takeJobs[jid]); return finishAt(st, endT, sb, eb); }
            }
            if(now() > deadline){ clearInterval(takeJobs[jid]); fail('Timed out waiting for the bars.'); }
          }, 60);
          return jid;
        }
        var span = recSpan(), sr = c.sampleRate;
        var endBar = Math.floor(gridAt(span.f1 / sr) + 1e-6), startBar = endBar - n;
        if(!isFinite(endBar)){ fail('Lost track of the bar lines. Try again while it plays.'); return jid; }
        while(startBar < endBar){
          var ts = barTime(startBar);
          if(ts != null && Math.round(ts * sr) >= span.f0) break;
          startBar++;
        }
        if(startBar >= endBar){ fail('Not a full bar recorded yet. Let it play a little longer, or use Record next.'); return jid; }
        var t0 = barTime(startBar), t1 = barTime(endBar);
        if(t0 == null || t1 == null){ fail('Lost track of the bar lines. Try again while it plays.'); return jid; }
        finishAt(t0, t1, startBar, endBar);
        return jid;
      }
      // seconds
      if(spec.mode === 'next'){
        var st0 = c.currentTime + 0.05, st1 = st0 + n;
        if(onWait) onWait({ startsInMs: 50, lengthSec: n });
        takeJobs[jid] = setInterval(function(){
          var span2 = recSpan(), cc = ctx();
          if(!cc || !rec || rec.ctx !== cc){ clearInterval(takeJobs[jid]); return fail('The sound stopped before the recording was done.'); }
          if(span2 && span2.f1 >= Math.round(st1 * cc.sampleRate)){ clearInterval(takeJobs[jid]); finishAt(st0, st1, null, null); }
        }, 60);
        return jid;
      }
      var sp = recSpan(), srr = c.sampleRate;
      var e1 = sp.f1 / srr, e0 = Math.max(sp.f0 / srr, e1 - n);
      finishAt(e0, e1, null, null);
      return jid;
    }
    function cancelTake(jid){ if(takeJobs[jid]){ clearInterval(takeJobs[jid]); delete takeJobs[jid]; } }

    /* the take's notes as a MIDI file (null when nothing was played in it) */
    function midiFor(tk){
      var bpm = tk.bpm || 120, beats = bpb();
      var total = Math.round((tk.bars ? tk.bars * beats : (tk.t1 - tk.t0) * bpm / 60) * PPQ);
      function tick(t){
        var v;
        if(tk.bars){ var b = gridAt(t); v = b == null ? (t - tk.t0) * bpm / 60 : (b - tk.startBar) * beats; }
        else v = (t - tk.t0) * bpm / 60;
        return Math.max(0, Math.min(total, Math.round(v * PPQ)));
      }
      var tracks = {}, order = [];
      function trk(e){ var k = e.track + '\u0001' + e.ch; if(!tracks[k]){ tracks[k] = { name: e.track, events: [] }; order.push(k); } return tracks[k]; }
      var any = false;
      events.forEach(function(e){
        if(e.kind === 'note'){
          var end = e.end == null ? tk.t1 : e.end;
          if(!(e.t < tk.t1 && end > tk.t0)) return;
          var a = tick(Math.max(e.t, tk.t0)), z = tick(Math.min(end, tk.t1));
          if(z <= a) z = Math.min(total, a + 1);
          if(z <= a) return;
          var tr = trk(e), c = e.ch - 1;
          tr.events.push({ tick: a, order: 1, bytes: [0x90 | c, e.pitch, e.vel] }, { tick: z, order: 0, bytes: [0x80 | c, e.pitch, 0] });
          any = true;
        } else if(e.kind === 'cc'){
          if(!(e.t >= tk.t0 && e.t < tk.t1)) return;
          trk(e).events.push({ tick: tick(e.t), order: 2, bytes: [0xB0 | (e.ch - 1), e.num, e.val] });
          any = true;
        }
      });
      if(!any) return null;
      // controllers start from their value at the beginning of the take
      events.forEach(function(e){
        if(e.kind !== 'cc' || e.t >= tk.t0) return;
        var tr = trk(e), k = 'cc' + e.num;
        tr._first = tr._first || {}; tr._first[k] = e;
      });
      order.forEach(function(k){ var tr = tracks[k]; if(tr._first) Object.keys(tr._first).forEach(function(q){ var e = tr._first[q]; tr.events.push({ tick: 0, order: -1, bytes: [0xB0 | (e.ch - 1), e.num, e.val] }); }); });
      return midiBlob(o.title, order.map(function(k){ return tracks[k]; }), bpm, beats);
    }
    function baseName(tk){
      var d = new Date(), p = function(x){ return String(x).padStart(2, '0'); };
      return slug(o.title) + '-' + (tk.bars ? tk.bars + (tk.bars === 1 ? 'bar' : 'bars') : Math.round(tk.t1 - tk.t0) + 's') +
        (tk.bpm ? '-' + Math.round(tk.bpm) + 'bpm' : '') + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
    /* save a take as WAV and/or MIDI; returns a short description of what was saved */
    function save(tk, fmt){
      var name = baseName(tk), files = [];
      var midi = fmt.midi && o.midi !== false ? midiFor(tk) : null;
      var wav = fmt.wav ? wavBlob(tk.left, tk.right, tk.sr) : null;
      var note = fmt.midi && o.midi !== false && !midi ? ' No notes were played in that stretch, so there is no MIDI file.' : '';
      if(wav && midi){
        return Promise.all([wav.arrayBuffer(), midi.arrayBuffer()]).then(function(r){
          download(zipBlob([{ name: name + '.wav', data: new Uint8Array(r[0]) }, { name: name + '.mid', data: new Uint8Array(r[1]) }]), name + '.zip');
          return 'Saved ' + name + '.zip (WAV and MIDI).';
        });
      }
      if(wav){ download(wav, name + '.wav'); files.push(name + '.wav'); }
      if(midi){ download(midi, name + '.mid'); files.push(name + '.mid'); }
      return Promise.resolve(files.length ? 'Saved ' + files.join(' and ') + '.' + note : 'Nothing to save.' + note);
    }

    /* ---- the Export bar ---- */
    var CSS = '.jx{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;font:inherit;color:inherit}' +
      '.jx *{box-sizing:border-box}.jx .jx-title{font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:11px;opacity:.75}' +
      '.jx .jx-led{width:8px;height:8px;border-radius:50%;background:rgba(128,128,128,.5);flex:none}' +
      '.jx .jx-led.on{background:var(--amber,#f2b648);box-shadow:0 0 6px var(--amber,#f2b648)}.jx .jx-led.ok{background:var(--teal,#3fbf6f);box-shadow:0 0 6px var(--teal,#3fbf6f)}' +
      '.jx label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:13px}.jx input[type=checkbox]{margin:0;accent-color:var(--oxide,var(--accent,#3a78c2))}' +
      '.jx .jx-status{flex:1 1 100%;font-size:13px;opacity:.75;min-height:1.3em}' +
      '.jx button.jx-d{font:inherit;padding:6px 11px;border-radius:5px;border:1px solid var(--line,rgba(128,128,128,.5));background:var(--panel-2,rgba(128,128,128,.14));color:inherit;cursor:pointer}' +
      '.jx button.jx-d.jx-p{background:var(--oxide,var(--accent,#3a78c2));border-color:var(--oxide-hi,var(--accent,#3a78c2));color:var(--on-accent,#fff)}' +
      '.jx button:disabled{opacity:.45;cursor:default}' +
      '.jx select.jx-d{font:inherit;padding:5px 7px;border-radius:5px;border:1px solid var(--line,rgba(128,128,128,.5));background:var(--well,rgba(128,128,128,.1));color:inherit}';
    function mount(el, ui){
      if(!el || typeof document === 'undefined') return null;
      ui = ui || {};
      if(!document.getElementById('jx-css')){ var st = document.createElement('style'); st.id = 'jx-css'; st.textContent = CSS; document.head.appendChild(st); }
      var root = document.createElement('div'); root.className = 'jx';
      var bcls = ui.btn || 'jx-d', pcls = ui.primary || 'jx-d jx-p', scls = ui.select || 'jx-d';
      root.innerHTML = '<span class="jx-led" aria-hidden="true"></span><span class="jx-title">' + (ui.title || 'Export') + '</span>' +
        '<select class="' + scls + ' jx-len" aria-label="Length"></select>' +
        '<label><input type="checkbox" class="jx-wav" checked> WAV</label>' +
        (o.midi === false ? '' : '<label><input type="checkbox" class="jx-midi" checked> MIDI</label>') +
        '<button type="button" class="' + pcls + ' jx-last"></button><button type="button" class="' + bcls + ' jx-next"></button>' +
        '<div class="jx-status" aria-live="polite"></div>';
      el.appendChild(root);
      var q = function(s){ return root.querySelector(s); };
      var lenEl = q('.jx-len'), wavEl = q('.jx-wav'), midiEl = q('.jx-midi'), lastBtn = q('.jx-last'), nextBtn = q('.jx-next'), status = q('.jx-status'), led = q('.jx-led');
      var unit = null, busy = null;
      try{ var saved = JSON.parse(localStorage.getItem('jx:' + o.app) || 'null'); if(saved){ wavEl.checked = saved.wav !== false; if(midiEl) midiEl.checked = saved.midi !== false; } }catch(e){}
      function remember(){ try{ localStorage.setItem('jx:' + o.app, JSON.stringify({ wav: wavEl.checked, midi: midiEl ? midiEl.checked : false, bars: unit === 'bars' ? lenEl.value : undefined })); }catch(e){} }
      function word(){ var n = Number(lenEl.value); return unit === 'bars' ? n + (n === 1 ? ' bar' : ' bars') : n + ' s'; }
      function setUnit(u){
        if(u === unit) return;
        var pickIdx = lenEl.selectedIndex;
        unit = u; lenEl.innerHTML = '';
        (u === 'bars' ? BAR_CHOICES : SEC_CHOICES).forEach(function(v){ var op = document.createElement('option'); op.value = v; op.textContent = u === 'bars' ? v + (v === 1 ? ' bar' : ' bars') : v + ' seconds'; lenEl.appendChild(op); });
        lenEl.selectedIndex = pickIdx >= 0 ? pickIdx : 2;
        if(u === 'bars'){ try{ var s = JSON.parse(localStorage.getItem('jx:' + o.app) || 'null'); if(s && s.bars) lenEl.value = s.bars; }catch(e){} }
      }
      function refresh(){
        var c = ctx(), live = !!(c && c.state === 'running');
        setUnit(o.grid && playing() ? 'bars' : 'sec');
        lastBtn.textContent = 'Save last ' + word();
        nextBtn.textContent = busy && busy.mode === 'next' ? 'Cancel' : 'Record next ' + word();
        var fmt = wavEl.checked || (midiEl && midiEl.checked);
        lastBtn.disabled = !!busy || !live || !fmt;
        nextBtn.disabled = busy ? busy.mode !== 'next' : (!live || !fmt);
        if(!busy && !status.dataset.msg) status.textContent = !live ? 'Start ' + o.title + ' to record. It keeps the last ' + KEEP_SEC + ' seconds of what plays.'
          : unit === 'bars' ? 'Save the bars that just played, or record from the next bar line.'
          : 'Save the last few seconds, or record from now.' + (o.grid ? ' Press play to work in bars.' : '');
      }
      function say(msg, keep){ status.textContent = msg; status.dataset.msg = keep ? '1' : ''; if(keep) setTimeout(function(){ if(status.textContent === msg){ status.dataset.msg = ''; refresh(); } }, 9000); }
      function go(mode){
        var fmt = { wav: wavEl.checked, midi: !!(midiEl && midiEl.checked) };
        remember();
        busy = { mode: mode };
        led.className = 'jx-led on';
        say(mode === 'next' ? 'Waiting to record ' + word() + '…' : 'Saving the last ' + word() + '…');
        refresh();
        busy.jid = take({ unit: unit, n: Number(lenEl.value), mode: mode }, function(err, tk){
          busy = null;
          if(err){ led.className = 'jx-led'; say(err, true); refresh(); return; }
          save(tk, fmt).then(function(msg){
            led.className = 'jx-led ok'; setTimeout(function(){ if(!busy) led.className = 'jx-led'; }, 1500);
            var short = tk.bars && unit === 'bars' && tk.bars < Number(lenEl.value) ? ' Only ' + tk.bars + ' full bar' + (tk.bars === 1 ? '' : 's') + ' had been recorded, so that\'s what was saved.' : '';
            say(msg + short, true); refresh();
          }, function(){ led.className = 'jx-led'; say('Could not make the file.', true); refresh(); });
        }, function(w){
          say('Recording ' + word() + (w.startsInMs != null && w.startsInMs > 120 ? ', starting in ' + (w.startsInMs / 1000).toFixed(1) + ' s' : '') + (w.lengthSec ? ' (about ' + w.lengthSec + ' s)' : '') + '…');
        });
      }
      lastBtn.addEventListener('click', function(){ go('last'); });
      nextBtn.addEventListener('click', function(){
        if(busy && busy.mode === 'next'){ cancelTake(busy.jid); busy = null; led.className = 'jx-led'; say('Cancelled.', true); refresh(); return; }
        go('next');
      });
      [wavEl, midiEl, lenEl].forEach(function(x){ if(x) x.addEventListener('change', function(){ remember(); refresh(); }); });
      refresh();
      setInterval(refresh, 500);
      return root;
    }

    /* clip requests from Tape Loop Deck */
    function handleReq(m){
      if(clipJob){ cancelTake(clipJob.jid); clipJob = null; }
      receivers[m.from] = now();
      var bars = clampInt(m.bars || 4, 1, MAX_BARS);
      var job = { reqId: m.reqId };
      job.jid = take({ unit:'bars', n: bars, mode: m.mode === 'next' ? 'next' : 'last' }, function(err, tk){
        if(clipJob === job) clipJob = null;
        if(err) return post({ t:'status', to: m.from, reqId: m.reqId, state:'error', msg: err });
        post({ t:'clip', to: m.from, reqId: m.reqId, title: o.title, sampleRate: tk.sr, left: tk.left, right: tk.right, bars: tk.bars, bpm: tk.bpm });
      }, function(w){
        post({ t:'status', to: m.from, reqId: m.reqId, state:'waiting', startsInMs: w.startsInMs, lengthSec: w.lengthSec });
      });
      clipJob = job;
    }
    function onMessage(m){
      if(m.from === id) return;
      switch(m.t){
        case 'rx':
          var first = !anyReceiver();
          receivers[m.from] = now();
          if(first) heartbeat();
          break;
        case 'bye': delete receivers[m.from]; break;
        case 'req': if(m.to === id) handleReq(m); break;
        case 'cancel': if(m.to === id && clipJob && clipJob.reqId === m.reqId){ cancelTake(clipJob.jid); clipJob = null; } break;
      }
    }
    setInterval(heartbeat, HB_MS);
    setInterval(check, CHECK_MS);
    if(ch) global.addEventListener('beforeunload', function(){ post({ t:'bye' }); });
    var api = {
      id: id,
      note: logNote, hold: logHold, release: logRelease, cc: logCC,
      mount: mount, take: take, cancel: cancelTake, save: save, midiFor: midiFor,
      refresh: connectNodes,   // call after the app rebuilds its output nodes
      debug: function(){ var s = recSpan(); return { receivers: Object.keys(receivers).length, recording: !!rec, seconds: s && rec ? (s.f1 - s.f0) / rec.ctx.sampleRate : 0, events: events.length }; }
    };
    registry.push(api);
    return api;
  }

  /* ---- receiver: Tape Loop Deck ----
     o = { onSources(list), onStatus(reqId, msg), onClip(reqId, clip) } */
  function receiver(o){
    var id = rid(), sources = {}, sig = '';
    var ch = openChannel(onMessage);
    if(!ch) return null;
    function post(m){ m.cv = CV; m.from = id; m.app = 'tape'; try{ ch.postMessage(m); }catch(e){} }
    function list(){
      var t = now();
      Object.keys(sources).forEach(function(k){ if(t - sources[k].ts > TTL_MS) delete sources[k]; });
      return Object.keys(sources).map(function(k){ return sources[k]; })
        .sort(function(a, b){ return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; });
    }
    function changed(){
      var l = list(), s = l.map(function(x){ return x.id + x.playing + x.bpm + x.rec; }).join('|');
      if(s !== sig){ sig = s; if(o.onSources) o.onSources(l); }
    }
    function onMessage(m){
      if(m.from === id) return;
      switch(m.t){
        case 'src':
          sources[m.from] = { id: m.from, app: m.app, title: m.title || m.app, playing: !!m.playing, bpm: m.bpm, rec: !!m.rec, ts: now() };
          changed();
          break;
        case 'bye': if(sources[m.from]){ delete sources[m.from]; changed(); } break;
        case 'status': if(m.to === id && o.onStatus) o.onStatus(m.reqId, m); break;
        case 'clip': if(m.to === id && o.onClip) o.onClip(m.reqId, m); break;
      }
    }
    post({ t:'rx' });
    setInterval(function(){ post({ t:'rx' }); changed(); }, HB_MS);
    global.addEventListener('beforeunload', function(){ post({ t:'bye' }); });
    return {
      id: id,
      sources: list,
      request: function(srcId, bars, mode){ var reqId = rid(); post({ t:'req', to: srcId, reqId: reqId, bars: bars, mode: mode === 'next' ? 'next' : 'last' }); return reqId; },
      cancel: function(srcId, reqId){ post({ t:'cancel', to: srcId, reqId: reqId }); }
    };
  }

  global.JamClips = { source: source, sources: function(){ return registry.slice(); }, receiver: receiver, barClock: barClock, wavBlob: wavBlob, zipBlob: zipBlob, download: download,
                      KEEP_SEC: KEEP_SEC, MAX_BARS: MAX_BARS };
})(typeof window !== 'undefined' ? window : globalThis);
