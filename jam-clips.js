/* ===== JAM CLIPS — Tape Loop Deck records bar-exact clips from the other apps =====
   One identical copy of this block is embedded in each app (between the JAM-CLIPS markers);
   jam-clips.js is the source copy.

   Apps that make sound (Logic Rhythm, Boolean Melody Machine, Choir, Pocket Grains) are clip
   *sources*. Tape Loop Deck is a clip *receiver*. They talk over a BroadcastChannel, so they must
   be open in the same browser and served from the same origin (aaronvandorn.github.io).

   While a receiver is open, each source keeps a rolling recording of its own output (the last
   KEEP_SEC seconds) through an AudioWorklet tap. The tap counts AudioContext frames, and the app's
   bar grid is in AudioContext time too, so a clip is cut on exact bar lines: a 4-bar clip is
   exactly 4 bars long and loops seamlessly at the tempo it was played at.

   The receiver asks a source for either
     - "last": the N bars that have just finished playing (retroactive, nothing to arm), or
     - "next": the N bars starting at the next bar line (the source waits, then sends them).
   The clip arrives as two Float32Arrays plus its sample rate, bar count and tempo.

   Messages: { cv:1, from, t, ... } on channel CHANNEL. A different envelope from Jam Link's, so
   Jam Link never mistakes a clip message for an app joining the jam.
     receiver -> all     rx        heartbeat ("a receiver is open, keep recording")
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
  var HB_MS = 1500, TTL_MS = 5000;
  var KEEP_SEC = 48;        // recent audio each source keeps while a receiver is open
  var MAX_BARS = 32;
  var BLOCK = 1024;
  var TAP_SRC = 'registerProcessor("jam-clip-tap", class extends AudioWorkletProcessor {' +
    'constructor(){ super(); this.l = new Float32Array(' + BLOCK + '); this.r = new Float32Array(' + BLOCK + '); this.n = 0; this.start = 0; }' +
    'process(inputs){ var input = inputs[0], a = input && input[0], b = input && (input[1] || input[0]);' +
    ' if(this.n === 0) this.start = currentFrame;' +
    // clamped to what the speakers can play, so the clip sounds like what was heard
    ' for(var i = 0; i < 128; i++){ var x = a ? a[i] : 0, y = b ? b[i] : 0; this.l[this.n + i] = x > 1 ? 1 : x < -1 ? -1 : x; this.r[this.n + i] = y > 1 ? 1 : y < -1 ? -1 : y; }' +
    ' this.n += 128;' +
    ' if(this.n >= ' + BLOCK + '){ this.port.postMessage({ frame: this.start, l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);' +
    '  this.l = new Float32Array(' + BLOCK + '); this.r = new Float32Array(' + BLOCK + '); this.n = 0; }' +
    ' return true; } });';

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
  function openChannel(onMsg){
    if(typeof BroadcastChannel === 'undefined') return null;
    var ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = function(e){ var m = e.data; if(m && m.cv === CV && typeof m.t === 'string') onMsg(m); };
    return ch;
  }

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

  /* ---- source: an app that can send clips ----
     o = { app, title, ctx: () => AudioContext|null, nodes: () => [AudioNode],
           grid: { barAt(ctxTime) -> bar number or null when stopped, timeOfBar(k) -> ctxTime },
           bpm: () => number, beatsPerBar?: 4 } */
  function source(o){
    var id = rid(), receivers = {}, rec = null, job = null, hbTimer = null;
    var bpb = o.beatsPerBar || 4;
    var ch = openChannel(onMessage);
    if(!ch) return null;

    function post(m){ m.cv = CV; m.from = id; m.app = o.app; try{ ch.postMessage(m); }catch(e){} }
    function anyReceiver(){
      var t = now(), any = false;
      Object.keys(receivers).forEach(function(k){ if(t - receivers[k] < TTL_MS) any = true; else delete receivers[k]; });
      return any;
    }
    function ctx(){ try{ return o.ctx ? o.ctx() : null; }catch(e){ return null; } }
    function playing(){ var c = ctx(); if(!c) return false; try{ return o.grid.barAt(c.currentTime) != null; }catch(e){ return false; } }
    function heartbeat(){
      var want = anyReceiver();
      if(want) ensureRec(); else stopRec();
      if(want){
        var bpm = null; try{ bpm = o.bpm ? Math.round(o.bpm() * 10) / 10 : null; }catch(e){}
        post({ t:'src', title: o.title, playing: playing(), bpm: bpm, rec: !!(rec && rec.blocks.length), keepSec: KEEP_SEC });
      }
    }

    /* rolling recording */
    function ensureRec(){
      var c = ctx();
      if(!c || !c.audioWorklet || typeof AudioWorkletNode === 'undefined'){ stopRec(); return; }
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

    /* requests */
    function fail(m, msg){ post({ t:'status', to: m.from, reqId: m.reqId, state:'error', msg: msg }); }
    function finish(m, sb, eb){
      var c = rec && rec.ctx, sr = c.sampleRate;
      var t0 = o.grid.timeOfBar(sb), t1 = o.grid.timeOfBar(eb);
      if(t0 == null || t1 == null || !(t1 > t0)) return fail(m, 'Lost track of the bar lines. Try again while it plays.');
      var data = extract(Math.round(t0 * sr), Math.round(t1 * sr));
      if(!data) return fail(m, 'That audio is no longer in ' + o.title + '\'s recent recording.');
      var bars = eb - sb, bpm = bars * bpb * 60 / (t1 - t0);
      post({ t:'clip', to: m.from, reqId: m.reqId, title: o.title, sampleRate: sr, left: data.left, right: data.right,
             bars: bars, bpm: Math.round(bpm * 100) / 100 });
    }
    function handleReq(m){
      if(job){ clearInterval(job.timer); job = null; }
      receivers[m.from] = now();
      ensureRec();
      var c = ctx();
      var bars = Math.max(1, Math.min(MAX_BARS, Math.round(Number(m.bars) || 4)));
      if(!c || c.state !== 'running') return fail(m, o.title + ' isn\'t making sound yet. Start it there first.');
      if(!rec || rec.ctx !== c || rec.starting){
        if(m.mode === 'last') return fail(m, o.title + ' has only just started recording. Try again in a few bars, or use Record next.');
      }
      var nowBar = o.grid.barAt(c.currentTime);
      if(nowBar == null) return fail(m, o.title + ' isn\'t playing. Press play there first.');
      var barSec = 60 * bpb / ((o.bpm && o.bpm()) || 120);
      if(bars * barSec > KEEP_SEC - 2) return fail(m, bars + ' bars is longer than ' + KEEP_SEC + ' seconds at this tempo. Choose fewer bars.');

      if(m.mode === 'next'){
        var sb = Math.ceil(nowBar - 1e-6), eb = sb + bars;
        var startT = o.grid.timeOfBar(sb);
        post({ t:'status', to: m.from, reqId: m.reqId, state:'waiting',
               startsInMs: startT != null ? Math.max(0, Math.round((startT - c.currentTime) * 1000)) : null,
               lengthSec: Math.round(bars * barSec * 10) / 10 });
        var deadline = now() + (bars * barSec + 12) * 1000;
        job = { reqId: m.reqId, timer: setInterval(function(){
          var span = recSpan(), cc = ctx();
          if(!cc || o.grid.barAt(cc.currentTime) == null){ clearInterval(job.timer); job = null; return fail(m, o.title + ' stopped before the bars were done.'); }
          if(span && rec && rec.ctx === cc){
            var endT = o.grid.timeOfBar(eb);
            if(endT != null && span.f1 >= Math.round(endT * cc.sampleRate)){ clearInterval(job.timer); job = null; return finish(m, sb, eb); }
          }
          if(now() > deadline){ clearInterval(job.timer); job = null; fail(m, 'Timed out waiting for the bars.'); }
        }, 60) };
        return;
      }
      // "last": the most recent N complete bars that are still in the recording
      var span = recSpan(); if(!span) return fail(m, 'Nothing recorded yet. Try again in a few bars.');
      var sr = c.sampleRate;
      var endBar = Math.floor(o.grid.barAt(span.f1 / sr) + 1e-6);
      var startBar = endBar - bars;
      while(startBar < endBar){
        var ts = o.grid.timeOfBar(startBar);
        if(ts != null && Math.round(ts * sr) >= span.f0) break;
        startBar++;
      }
      if(startBar >= endBar) return fail(m, 'Not a full bar recorded yet. Let it play a little longer, or use Record next.');
      finish(m, startBar, endBar);
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
        case 'cancel': if(m.to === id && job && job.reqId === m.reqId){ clearInterval(job.timer); job = null; } break;
      }
    }
    hbTimer = setInterval(heartbeat, HB_MS);
    global.addEventListener('beforeunload', function(){ post({ t:'bye' }); });
    return {
      id: id,
      debug: function(){ var s = recSpan(); return { receivers: Object.keys(receivers).length, recording: !!rec, seconds: s && rec ? (s.f1 - s.f0) / rec.ctx.sampleRate : 0 }; },
      refresh: connectNodes   // call after the app rebuilds its output nodes
    };
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

  global.JamClips = { source: source, receiver: receiver, barClock: barClock, KEEP_SEC: KEEP_SEC, MAX_BARS: MAX_BARS };
})(typeof window !== 'undefined' ? window : globalThis);
