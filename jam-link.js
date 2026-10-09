/* ===== JAM LINK — shared transport for Logic Rhythm, Boolean Melody Machine and Choir =====
   One identical copy of this block is embedded in each app (between the JAM-LINK markers).
   Apps in different tabs/windows of the same browser talk over a BroadcastChannel, so they must be
   served from the same origin (they are: aaronvandorn.github.io).

   Timing: every tab has its own AudioContext clock, so the shared timeline lives on the wall clock
   (performance.timeOrigin + performance.now()). A transport is a list of tempo "segments"
   { bpm, anchorWall, anchorBeat }: beat b happens at anchorWall + (b - anchorBeat) * 60000 / bpm.
   Tempo changes start a new segment that begins slightly in the future, so every app has the same
   mapping from beats to time and nobody drifts. Each app converts that wall time into its own
   AudioContext time with getOutputTimestamp().

   Discobot guest: when the page is shown in a frame by Discobot (https://iw978599.github.io/discobot/),
   the app becomes a unit in Discobot's rack. Discobot sends tempo and start/stop on the same wall
   clock, asks for and restores the app's settings, and takes its sound as PCM blocks over
   postMessage. While hosted, Jam Link's own linking is off for the session. None of this is active
   unless the page is framed and has received a valid "hello". Protocol:
   https://github.com/iw978599/discobot/blob/main/docs/GUEST_PROTOCOL.md */
(function(global){
  'use strict';
  var CHANNEL_NAME = 'aaronvandorn-jam-v1';
  var SCENES_KEY = 'aaronvandornJamScenes';
  var LEAD_MS = 150;        // how far ahead a shared start or tempo change is placed
  var JOIN_LEAD_MS = 70;    // minimum time needed to start an app that is joining
  var BAR_BEATS = 4;        // late joiners enter on the next multiple of this many beats
  var HB_MS = 1500, PEER_TTL_MS = 5000, SCENE_WAIT_MS = 700;
  var BPM_MIN = 40, BPM_MAX = 240;
  var BROWSER_ID = (function(){ try{ var v = localStorage.getItem('jam:browserId'); if(!v){ v = Math.random().toString(36).slice(2, 10); localStorage.setItem('jam:browserId', v); } return v; }catch(e){ return Math.random().toString(36).slice(2, 10); } })();
  var MAX_SLOTS = 8, CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var APP_NAMES = { choir:'Choir', logic:'Logic Rhythm', bmm:'Melody Machine' };
  var FULL_NAMES = { choir:'Choir', logic:'Logic Rhythm', bmm:'Boolean Melody Machine' };
  var GUEST_PROTOCOL = 1;
  var HOST_WAIT_MS = 1500;  // a framed page waits this long for Discobot before restoring the saved Link setting
  // Gathers the tapped output into 1,024-frame stereo blocks for the host.
  var GUEST_TAP_SRC = 'registerProcessor("jam-guest-tap", class extends AudioWorkletProcessor {' +
    'constructor(){ super(); this.l = new Float32Array(1024); this.r = new Float32Array(1024); this.n = 0; this.start = 0; }' +
    'process(inputs){ var input = inputs[0], a = input && input[0], b = input && (input[1] || input[0]);' +
    ' if(this.n === 0) this.start = currentFrame;' +
    ' for(var i = 0; i < 128; i++){ var x = a ? a[i] : 0, y = b ? b[i] : 0; this.l[this.n + i] = x > 1 ? 1 : x < -1 ? -1 : x; this.r[this.n + i] = y > 1 ? 1 : y < -1 ? -1 : y; }' +
    ' this.n += 128;' +
    ' if(this.n >= 1024){ this.port.postMessage({ frame: this.start, l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);' +
    '  this.l = new Float32Array(1024); this.r = new Float32Array(1024); this.n = 0; }' +
    ' return true; } });';

  function wallNow(){ return performance.timeOrigin + performance.now(); }
  function clampBpm(v){ return Math.max(BPM_MIN, Math.min(BPM_MAX, v)); }

  /* ---- tempo segment maths ---- */
  function segAtBeat(segs, b){ var s = segs[0]; for(var i=0;i<segs.length;i++){ if(segs[i].anchorBeat <= b) s = segs[i]; } return s; }
  function segAtWall(segs, w){ var s = segs[0]; for(var i=0;i<segs.length;i++){ if(segs[i].anchorWall <= w) s = segs[i]; } return s; }
  function beatToWall(segs, b){ var s = segAtBeat(segs, b); return s.anchorWall + (b - s.anchorBeat) * 60000 / s.bpm; }
  function wallToBeat(segs, w){ var s = segAtWall(segs, w); return s.anchorBeat + (w - s.anchorWall) * s.bpm / 60000; }
  function insertSeg(segs, seg){
    var out = segs.filter(function(s){ return s.anchorWall < seg.anchorWall; });
    out.push(seg);
    return out.slice(-64);
  }
  function makeSeg(segs, bpm, leadMs){
    var w = wallNow() + leadMs;
    return { bpm: bpm, anchorWall: w, anchorBeat: segs.length ? wallToBeat(segs, w) : 0 };
  }

  function create(opts){
    var o = opts;
    var feat = Object.assign({ tempo:true, transport:true, key:false, scenes:true }, o.features || {});
    var id = Math.random().toString(36).slice(2, 10);
    var prefKey = function(k){ return 'jam:' + o.app + ':' + k; };
    function prefGet(k, d){ try{ var v = localStorage.getItem(prefKey(k)); return v === null ? d : JSON.parse(v); }catch(e){ return d; } }
    function prefSet(k, v){ try{ localStorage.setItem(prefKey(k), JSON.stringify(v)); }catch(e){} }

    var linked = false;
    var displayName = prefGet('name', '');
    var follow = { tempo: prefGet('tempo', true), transport: prefGet('transport', true), key: prefGet('key', true), scenes: prefGet('scenes', true) };
    var trimMs = prefGet('trim', 0); // fine phase adjustment for this app (ms, + = later)
    var mySegs = [], sharedSegs = [], originBeat = 0;
    var playing = false, applying = false;
    var sharedKey = null;
    var peers = {};
    var channel = null, hbTimer = null, uiTimer = null;
    var pendingScene = null;
    var ui = null;
    // Discobot hosting. `framed` is fixed at load; `host.on` only after a valid hello.
    var framed = false; try{ framed = global.parent !== global; }catch(e){ framed = true; }
    var host = { on: false, origin: null, latencyMs: 0, audio: false, playing: false, segs: [], startBeat: 0 };

    /* ---- clock conversion ---- */
    function ctx(){ return o.ctx ? o.ctx() : null; }
    // The wall <-> audio clock pairing is sampled from getOutputTimestamp() and held for a fraction
    // of a second so every step is placed against the same reference (no per-call jitter).
    var ref = null;
    function mapRef(){
      var c = ctx(); if(!c) return null;
      var n = performance.now();
      if(ref && ref.c === c && c.state === 'running' && n - ref.at < 300) return ref;
      var ts = c.getOutputTimestamp ? c.getOutputTimestamp() : null;
      var r = (ts && ts.performanceTime > 0 && ts.contextTime > 0)
        ? { c: c, ctxT: ts.contextTime, wall: performance.timeOrigin + ts.performanceTime, at: n }
        : { c: c, ctxT: c.currentTime, wall: wallNow(), at: n };
      ref = c.state === 'running' ? r : null;
      return r;
    }
    function ctxAtWall(w){ var r = mapRef(); return r ? r.ctxT + (w - r.wall) / 1000 : 0; }
    function wallAtCtx(t){ var r = mapRef(); return r ? r.wall + (t - r.ctxT) * 1000 : wallNow(); }
    // How far this app is shifted from the shared beat (ms, + = later). Normally the user's Sync trim.
    // While Discobot carries the sound, everything is played latencyMs early instead (Discobot holds
    // the audio back by the same amount); the trim is for this page's own speakers, so it is not used.
    function offsetMs(){ return host.on && host.audio ? -host.latencyMs : trimMs; }
    // Local beat 0 is the moment this app started. These are what the apps schedule against.
    function timeOfBeat(localBeat){
      if(!mySegs.length) return ctx() ? ctx().currentTime : 0;
      return ctxAtWall(beatToWall(mySegs, originBeat + localBeat)) + offsetMs() / 1000;
    }
    function beatAt(ctxTime){
      if(!mySegs.length) return 0;
      return wallToBeat(mySegs, wallAtCtx(ctxTime) - offsetMs()) - originBeat;
    }
    function bpmNow(){
      if(playing && mySegs.length) return mySegs[mySegs.length-1].bpm;
      return o.bpm();
    }

    /* ---- messaging ---- */
    function send(msg){
      if(!linked) return;
      msg.v = 1; msg.from = id; msg.app = o.app;
      if(displayName) msg.name = displayName;
      if(channel){ try{ channel.postMessage(msg); }catch(e){} }
      else { try{ localStorage.setItem('jam:msg', JSON.stringify({ n: Math.random(), m: msg })); }catch(e){} }
      netBroadcast(msg);
    }
    function anyPeerPlaying(){
      var now = wallNow();
      return Object.keys(peers).some(function(k){ return peers[k].playing && now - peers[k].ts < PEER_TTL_MS; });
    }
    function peerList(){
      var now = wallNow();
      return Object.keys(peers).filter(function(k){ return now - peers[k].ts < PEER_TTL_MS; }).map(function(k){ return peers[k]; });
    }
    function withApplying(fn){ var was = applying; applying = true; try{ fn(); } finally { applying = was; } }

    function onMessage(m){
      if(!m || m.v !== 1 || m.from === id || !linked) return;
      if(m.to && m.to !== id) return;
      if(m._net && m.browser && m.browser === BROWSER_ID){ netIgnore(m._net); return; } // another tab of this very browser: already linked locally
      if(m.t !== 'bye'){
        var prev = peers[m.from];
        peers[m.from] = { id: m.from, app: m.app, playing: !!(m.t === 'play' ? m.playing : (prev && prev.playing)), ts: wallNow(),
                          name: m.name || (prev && prev.name) || '', net: m._net || (prev && prev.net) || null };
      }
      switch(m.t){
        case 'hello':
          send({ t:'welcome', browser: BROWSER_ID, to: m.from, playing: playing, bpm: bpmNow(), segs: playing ? mySegs : sharedSegs, key: sharedKey || currentKey() });
          break;
        case 'welcome':
          peers[m.from].playing = !!m.playing;
          if(m.segs && m.segs.length && (m.playing || !sharedSegs.length)) sharedSegs = m.segs;
          if(m.key && follow.key && feat.key && !playing) applyKey(m.key);
          if(follow.tempo && feat.tempo && !playing && m.bpm) withApplying(function(){ o.applyBpm(clampBpm(m.bpm)); });
          if(m.playing && follow.transport && feat.transport && !playing && o.start && !pendingJoin){
            pendingJoin = true;
            setTimeout(function(){ pendingJoin = false; if(linked && !playing && anyPeerPlaying() && canAutoplay()) withApplying(function(){ o.start(true); }); }, 50);
          }
          break;
        case 'hb':
        case 'play':
          if(m.t === 'play') peers[m.from].playing = !!m.playing;
          else peers[m.from].playing = !!m.playing;
          break;
        case 'bye':
          delete peers[m.from];
          break;
        case 'tempo':
          if(!feat.tempo) break;
          sharedSegs = insertSeg(sharedSegs, m.seg);
          if(follow.tempo){
            if(playing) mySegs = insertSeg(mySegs, m.seg);
            withApplying(function(){ o.applyBpm(m.seg.bpm); });
          }
          break;
        case 'start':
          if(!feat.transport) break;
          sharedSegs = [m.seg];
          peers[m.from].playing = true;
          if(follow.transport && !playing && o.start && canAutoplay()) withApplying(function(){ o.start(true); });
          break;
        case 'stop':
          if(!feat.transport) break;
          peers[m.from].playing = false;
          if(follow.transport && playing && o.stop) withApplying(function(){ o.stop(true); });
          break;
        case 'key':
          if(!feat.key) break;
          sharedKey = m.key;
          if(follow.key) applyKey(m.key);
          break;
        case 'scene-capture':
          if(feat.scenes && follow.scenes && o.scene){
            send({ t:'scene-part', to: m.from, sceneId: m.sceneId, state: o.scene.capture() });
          }
          break;
        case 'scene-part':
          if(pendingScene && pendingScene.id === m.sceneId) pendingScene.parts[m.app] = m.state;
          break;
        case 'scene-load':
          if(feat.scenes && follow.scenes && o.scene){
            var sc = findScene(m.sceneId);
            if(!sc && m.scene){ sc = m.scene; var all = readScenes(); all.push(sc); writeScenes(all); renderScenes(); }
            if(sc && sc.parts[o.app]){
              withApplying(function(){
                o.scene.apply(sc.parts[o.app]);
                if(follow.tempo && feat.tempo){
                  var cur = playing && mySegs.length ? mySegs[mySegs.length-1].bpm : (sharedSegs.length ? sharedSegs[sharedSegs.length-1].bpm : sc.bpm);
                  o.applyBpm(cur);
                }
                if(follow.key && feat.key && sharedKey) applyKey(sharedKey);
              });
            }
          }
          break;
      }
      refreshUI();
    }
    var pendingJoin = false;
    // Discobot frames the page with allow="autoplay" and the user has pressed play there.
    function canAutoplay(){ return host.on || typeof navigator === 'undefined' || !navigator.userActivation || navigator.userActivation.hasBeenActive; }

    function currentKey(){ return feat.key && o.key ? o.key.get() : null; }
    function applyKey(k){ if(feat.key && o.key && k) withApplying(function(){ o.key.set(k); }); }

    /* ---- what the apps call ---- */
    function begin(remote){
      var now = wallNow();
      if(host.on) return beginHosted(now);
      var share = linked && follow.transport && feat.transport;
      var join = share && sharedSegs.length && (remote || anyPeerPlaying());
      if(join){
        var nb = Math.max(0, Math.ceil(wallToBeat(sharedSegs, now + JOIN_LEAD_MS) / BAR_BEATS - 1e-9) * BAR_BEATS);
        var wallStart = beatToWall(sharedSegs, nb);
        originBeat = nb;
        mySegs = (follow.tempo && feat.tempo) ? sharedSegs.slice()
               : [{ bpm: clampBpm(o.bpm()), anchorWall: wallStart, anchorBeat: nb }];
      } else if(share){
        var seg = { bpm: clampBpm(o.bpm()), anchorWall: now + leadMs(), anchorBeat: 0 };
        sharedSegs = [seg]; mySegs = [seg]; originBeat = 0;
        playing = true;
        send({ t:'start', seg: seg });
      } else {
        mySegs = [{ bpm: clampBpm(o.bpm()), anchorWall: now + JOIN_LEAD_MS, anchorBeat: 0 }];
        originBeat = 0;
      }
      playing = true;
      send({ t:'play', playing: true });
      refreshUI();
      return { startCtx: timeOfBeat(0), bpm: mySegs[mySegs.length-1].bpm };
    }
    function end(){
      if(!playing) return;
      playing = false;
      if(!applying && linked && follow.transport && feat.transport) send({ t:'stop' });
      send({ t:'play', playing: false });
      refreshUI();
    }
    // Slider drags fire many events; send at most one tempo change every ~40 ms.
    var tempoTimer = null, pendingBpm = null;
    function userTempo(bpm){
      if(applying) return;
      if(host.on){ hostTempoSnapBack(); return; } // Discobot sets the tempo while hosted
      pendingBpm = bpm;
      if(tempoTimer) return;
      tempoTimer = setTimeout(function(){ tempoTimer = null; commitTempo(pendingBpm); }, 40);
    }
    function commitTempo(bpm){
      bpm = clampBpm(bpm);
      var share = linked && follow.tempo && feat.tempo;
      var base = playing ? mySegs : (sharedSegs.length ? sharedSegs : mySegs);
      if(!share){
        // placed just beyond the scheduler's look-ahead so steps already queued are not disturbed
        if(playing) mySegs = insertSeg(mySegs, makeSeg(mySegs, bpm, leadMs()));
        return;
      }
      var seg = makeSeg(base, bpm, playing || anyPeerPlaying() ? leadMs() : 0);
      sharedSegs = insertSeg(sharedSegs, seg);
      if(playing) mySegs = insertSeg(mySegs, seg);
      send({ t:'tempo', seg: seg });
    }
    function userKey(root, mode){
      if(applying || !feat.key) return;
      var k = { root: root, mode: mode };
      sharedKey = k;
      if(linked && follow.key) send({ t:'key', key: k });
    }

    /* ---- scenes ---- */
    function readScenes(){ try{ return JSON.parse(localStorage.getItem(SCENES_KEY)) || []; }catch(e){ return []; } }
    function writeScenes(list){ try{ localStorage.setItem(SCENES_KEY, JSON.stringify(list.slice(-40))); }catch(e){} }
    function findScene(sid){ return readScenes().filter(function(s){ return s.id === sid; })[0]; }
    function saveScene(name, done){
      if(!o.scene) return;
      var sid = 's' + Date.now();
      pendingScene = { id: sid, parts: {} };
      pendingScene.parts[o.app] = o.scene.capture();
      send({ t:'scene-capture', sceneId: sid });
      setTimeout(function(){
        var list = readScenes();
        list.push({ id: sid, name: name, ts: Date.now(), bpm: bpmNow(), key: currentKey() || sharedKey, parts: pendingScene.parts });
        writeScenes(list);
        var apps = Object.keys(pendingScene.parts);
        pendingScene = null;
        renderScenes();
        if(done) done(apps);
      }, linked ? SCENE_WAIT_MS : 0);
    }
    function loadScene(sid){
      var sc = findScene(sid); if(!sc) return;
      withApplying(function(){ if(sc.parts[o.app] && o.scene) o.scene.apply(sc.parts[o.app]); });
      if(follow.tempo && feat.tempo && sc.bpm){ withApplying(function(){ o.applyBpm(clampBpm(sc.bpm)); }); userTempo(sc.bpm); }
      if(follow.key && feat.key && sc.key){ applyKey(sc.key); userKey(sc.key.root, sc.key.mode); }
      if(linked) send({ t:'scene-load', sceneId: sid, scene: sc });
    }
    function deleteScene(sid){ writeScenes(readScenes().filter(function(s){ return s.id !== sid; })); renderScenes(); }

    /* ---- link on/off ---- */
    function setLinked(on, sessionOnly){
      if(on === linked) return;
      if(on && host.on) return; // no linking while Discobot drives the transport
      if(on){
        linked = true;
        if(typeof BroadcastChannel !== 'undefined'){
          channel = new BroadcastChannel(CHANNEL_NAME);
          channel.onmessage = function(e){ onMessage(e.data); };
        } else {
          global.addEventListener('storage', storageHandler);
        }
        send({ t:'hello', browser: BROWSER_ID });
        send({ t:'play', playing: playing });
        hbTimer = setInterval(function(){ send({ t:'hb', playing: playing }); }, HB_MS);
        if(o.unlock) o.unlock();
      } else {
        send({ t:'bye' });
        linked = false;
        clearInterval(hbTimer); hbTimer = null;
        if(channel){ channel.close(); channel = null; }
        global.removeEventListener('storage', storageHandler);
        peers = {};
      }
      if(!sessionOnly) prefSet('linked', on);
      refreshUI();
    }
    function storageHandler(e){
      if(e.key !== 'jam:msg' || !e.newValue) return;
      try{ onMessage(JSON.parse(e.newValue).m); }catch(err){}
    }
    function setFollow(k, on){ follow[k] = on; prefSet(k, on); refreshUI(); }

    /* ---- online jam: peers in other places (WebRTC through PeerJS, room code) ----
       A room is just a short code. Everyone takes the lowest free slot "aaronjam-CODE-n" on the PeerJS
       broker; a newer arrival (higher slot) dials every lower slot, so the group ends up fully meshed.
       Each pair gets a data channel (the same messages the local tabs use) and an audio call that
       carries this app's output. Clocks differ between computers, so each link measures the offset
       and converts the wall times in every message. */
    var net = { peer: null, code: null, slot: -1, entries: {}, scan: null, ping: null, status: '', claiming: false };
    var sendDest = null, tappedNodes = [];
    var monitor = null, pcm = { node: null, ctx: null, ready: null, blocks: 0 }; // Discobot: own-speaker gain, PCM tap

    function leadMs(){
      var worst = 0;
      Object.keys(net.entries).forEach(function(k){ var e = net.entries[k]; if(e.open && !e.ignore) worst = Math.max(worst, (e.rtt || 0) / 2); });
      return Math.max(LEAD_MS, worst + 150); // long enough for the message to arrive and still be inside everyone's look-ahead
    }
    function netOpenEntries(){ return Object.keys(net.entries).map(function(k){ return net.entries[k]; }).filter(function(e){ return e.open && !e.ignore; }); }
    function netBroadcast(msg){
      netOpenEntries().forEach(function(e){ try{ e.conn.send(msg); }catch(err){} });
    }
    function slotName(s){ return 'aaronjam-' + net.code + '-' + s; }
    function slotOf(peerId){ var m = /-(\d+)$/.exec(peerId || ''); return m ? parseInt(m[1], 10) : -1; }
    function normCode(c){ return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
    function randomCode(){ var s = ''; for(var i=0;i<6;i++) s += CODE_ALPHABET[Math.floor(Math.random()*CODE_ALPHABET.length)]; return s; }

    function ensureSendDest(){
      var c = ctx();
      if(!c || !c.createMediaStreamDestination) return null;
      if(!sendDest || sendDest.context !== c){ sendDest = c.createMediaStreamDestination(); tappedNodes.forEach(function(n){ try{ n.connect(sendDest); }catch(e){} }); }
      return sendDest;
    }
    // The app hands over its final output node(s); a copy of that signal is what other places hear.
    function tapAudio(node){
      if(!node) return;
      if(tappedNodes.indexOf(node) < 0){ tappedNodes.push(node); if(tappedNodes.length > 8) tappedNodes.shift(); }
      var d = ensureSendDest();
      if(d){ try{ node.connect(d); }catch(e){} }
      if(pcm.node && node.context === pcm.ctx){ try{ node.connect(pcm.node); }catch(e){} }
    }
    function sendStream(){ var d = ensureSendDest(); return d ? d.stream : new MediaStream(); }

    function loadPeerJS(){
      if(global.Peer) return Promise.resolve();
      return new Promise(function(resolve, reject){
        var urls = [global.JAM_PEERJS_URL || 'peerjs.min.js', 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'];
        (function next(i){
          if(i >= urls.length) return reject(new Error('Could not load the PeerJS library'));
          var sc = document.createElement('script'); sc.src = urls[i];
          sc.onload = function(){ global.Peer ? resolve() : next(i + 1); };
          sc.onerror = function(){ next(i + 1); };
          document.head.appendChild(sc);
        })(0);
      });
    }

    function netStatus(text){ net.status = text; refreshUI(); }

    function joinRoom(code){
      if(host.on) return;
      code = normCode(code);
      if(code.length < 4){ netStatus('Enter the room code you were given.'); return; }
      if(net.code) leaveRoom();
      net.code = code; net.slot = -1;
      if(o.unlock) o.unlock();                // the click that got us here lets audio start
      if(!linked) setLinked(true);
      netStatus('Connecting to room ' + code + '…');
      loadPeerJS().then(function(){ if(net.code === code) claimSlot(0); })
        .catch(function(){ net.code = null; netStatus('Online jam needs the PeerJS library, which could not be loaded.'); });
    }
    function createRoom(){ joinRoom(randomCode()); }

    function claimSlot(s){
      if(s >= MAX_SLOTS){ var full = net.code; leaveRoom(); netStatus('Room ' + full + ' is full.'); return; }
      var opts = Object.assign({ debug: 0 }, global.JAM_PEER_OPTIONS || {});
      var peer = new global.Peer(slotName(s), opts);
      net.peer = peer;
      var settled = false;
      peer.on('open', function(){
        settled = true; net.slot = s;
        netStatus('In room ' + net.code + (netOpenEntries().length ? '' : ' — waiting for others. Share the code.'));
        peer.on('connection', function(conn){ netAttach(conn, false); });
        peer.on('call', function(call){ var e = netEntry(slotOf(call.peer)); call.answer(sendStream()); netCall(e, call); });
        scanRoom();
        net.scan = setInterval(scanRoom, 4000);
        net.ping = setInterval(pingAll, 2500);
      });
      peer.on('error', function(err){
        if(err && err.type === 'unavailable-id' && !settled){ try{ peer.destroy(); }catch(e){} claimSlot(s + 1); return; }
        if(err && err.type === 'peer-unavailable') return;  // nobody in that slot (yet)
        if(!settled){ var c = net.code; leaveRoom(); netStatus('Could not reach the room service (' + ((err && err.type) || 'error') + ').'); }
      });
      peer.on('disconnected', function(){ try{ if(!peer.destroyed) peer.reconnect(); }catch(e){} });
    }

    function netEntry(slot){
      return net.entries[slot] || (net.entries[slot] = { slot: slot, conn: null, call: null, open: false, ignore: false, off: 0, rtt: 0, samples: [], vol: 1, muted: false, audio: null, since: Date.now() });
    }
    // Higher slots dial lower ones, so every pair is connected exactly once.
    function scanRoom(){
      if(!net.peer || net.slot < 0) return;
      for(var l = 0; l < net.slot; l++){
        var e = net.entries[l];
        if(e && e.ignore) continue;
        if(e && e.conn && (e.open || Date.now() - e.since < 9000)) continue;
        if(e && e.conn){ try{ e.conn.close(); }catch(err){} }
        e = netEntry(l); e.since = Date.now(); e.open = false;
        netAttach(net.peer.connect(slotName(l), { serialization: 'json', reliable: true }), true);
      }
    }
    function netAttach(conn, dialed){
      var e = netEntry(slotOf(conn.peer));
      if(e.conn && e.conn !== conn && e.open){ try{ conn.close(); }catch(err){} return; }
      e.conn = conn; e.since = Date.now();
      conn.on('open', function(){
        e.open = true; e.samples = [];
        if(dialed && net.peer && !e.call && !e.ignore) netCall(e, net.peer.call(slotName(e.slot), sendStream()));
        try{ conn.send({ v:1, t:'hello', from:id, app:o.app, browser:BROWSER_ID, name:displayName }); }catch(err){}
        for(var i=0;i<8;i++) (function(k){ setTimeout(function(){ pingOne(e); }, k * 120); })(i);
        refreshUI();
      });
      conn.on('data', function(d){ netData(e, d); });
      conn.on('close', function(){ if(e.conn === conn) netDrop(e); });
      conn.on('error', function(){ if(e.conn === conn) netDrop(e); });
    }
    function netCall(e, call){
      e.call = call;
      call.on('stream', function(rs){ netPlay(e, rs); });
      call.on('close', function(){ netStopAudio(e); });
    }
    function netPlay(e, stream){
      netStopAudio(e);
      var a = document.createElement('audio');
      a.autoplay = true; a.playsInline = true; a.srcObject = stream;
      a.volume = e.vol; a.muted = e.muted; a.style.display = 'none';
      document.body.appendChild(a);
      var p = a.play();
      if(p && p.catch) p.catch(function(){ document.addEventListener('click', function once(){ document.removeEventListener('click', once); a.play(); }); });
      e.audio = a;
    }
    function netStopAudio(e){ if(e.audio){ try{ e.audio.pause(); e.audio.srcObject = null; e.audio.remove(); }catch(err){} e.audio = null; } }
    function netDrop(e){
      e.open = false; netStopAudio(e);
      try{ if(e.call) e.call.close(); }catch(err){} e.call = null;
      Object.keys(peers).forEach(function(k){ if(peers[k].net === e) delete peers[k]; });
      refreshUI();
    }
    function netIgnore(e){ e.ignore = true; netDrop(e); try{ e.conn.close(); }catch(err){} }

    function pingOne(e){ if(e.open){ try{ e.conn.send({ nt:'ping', t0: wallNow() }); }catch(err){} } }
    function pingAll(){ netOpenEntries().forEach(pingOne); }

    function convertWalls(m, off){
      if(!off) return;
      if(m.seg) m.seg = Object.assign({}, m.seg, { anchorWall: m.seg.anchorWall - off });
      if(m.segs) m.segs = m.segs.map(function(s){ return Object.assign({}, s, { anchorWall: s.anchorWall - off }); });
    }
    function netData(e, d){
      if(!d) return;
      if(d.nt === 'ping'){ var t1 = wallNow(); try{ e.conn.send({ nt:'pong', t0:d.t0, t1:t1, t2:wallNow() }); }catch(err){} return; }
      if(d.nt === 'pong'){
        var t3 = wallNow(), rtt = (t3 - d.t0) - (d.t2 - d.t1), off = ((d.t1 - d.t0) + (d.t2 - t3)) / 2;
        e.samples.push({ rtt: rtt, off: off }); if(e.samples.length > 16) e.samples.shift();
        var best = e.samples.slice().sort(function(a, b){ return a.rtt - b.rtt; }).slice(0, 4);
        e.off = best.reduce(function(s, x){ return s + x.off; }, 0) / best.length;
        e.rtt = best.reduce(function(s, x){ return s + x.rtt; }, 0) / best.length;
        return;
      }
      if(d.v !== 1) return;
      convertWalls(d, e.off);
      d._net = e;
      onMessage(d);
    }

    function leaveRoom(){
      clearInterval(net.scan); clearInterval(net.ping);
      Object.keys(net.entries).forEach(function(k){ var e = net.entries[k]; netStopAudio(e); try{ if(e.call) e.call.close(); }catch(err){} try{ if(e.conn) e.conn.close(); }catch(err){} });
      Object.keys(peers).forEach(function(k){ if(peers[k].net) delete peers[k]; });
      try{ if(net.peer) net.peer.destroy(); }catch(err){}
      net = { peer: null, code: null, slot: -1, entries: {}, scan: null, ping: null, status: '', claiming: false };
      refreshUI();
    }
    function setPeerVolume(slot, v){ var e = net.entries[slot]; if(!e) return; e.vol = v; if(e.audio) e.audio.volume = v; }
    function setPeerMuted(slot, m){ var e = net.entries[slot]; if(!e) return; e.muted = m; if(e.audio) e.audio.muted = m; }

    /* ---- Discobot guest ----
       Discobot frames the page, says hello, then drives the transport with
       { bpm, anchorWall, anchorBeat } segments on the shared wall clock, which are exactly Jam Link
       tempo segments. It asks for settings (getState) and restores them (setState), and while its
       audio is on it takes this app's sound as PCM over postMessage instead of the page's speakers. */
    function beginHosted(now){
      if(host.playing && host.segs.length){
        // Discobot's start beat (normally beat 0, placed a little in the future). Only if that can no
        // longer be placed on time, come in on the next bar line.
        var earliest = wallToBeat(host.segs, now + JOIN_LEAD_MS - offsetMs());
        originBeat = earliest <= host.startBeat + 1e-9 ? host.startBeat
                   : Math.ceil(earliest / BAR_BEATS - 1e-9) * BAR_BEATS;
        mySegs = host.segs.slice();
      } else {
        // Started while Discobot is stopped (or it stopped while the app was getting ready):
        // run on a local clock for a moment and stop again.
        mySegs = [{ bpm: o.bpm(), anchorWall: now + JOIN_LEAD_MS, anchorBeat: 0 }];
        originBeat = 0;
        setTimeout(function(){ if(host.on && !host.playing && playing && o.stop) withApplying(function(){ o.stop(true); }); }, 0);
      }
      playing = true;
      refreshUI();
      return { startCtx: timeOfBeat(0), bpm: mySegs[mySegs.length-1].bpm };
    }
    var snapTimer = null;
    function hostBpm(){ return host.segs.length ? host.segs[host.segs.length-1].bpm : null; }
    // The user moved this app's tempo control while hosted: put it back to Discobot's tempo.
    function hostTempoSnapBack(){
      if(hostBpm() === null) return;
      clearTimeout(snapTimer);
      snapTimer = setTimeout(function(){ if(host.on && hostBpm() !== null) withApplying(function(){ o.applyBpm(hostBpm()); }); }, 800);
    }
    function hostSend(msg, transfer){
      if(!framed) return;
      msg.discobotGuest = GUEST_PROTOCOL;
      // Before the host has spoken its address is unknown; only "ready" is sent then.
      var target = host.origin && host.origin !== 'null' ? host.origin : '*';
      try{ global.parent.postMessage(msg, target, transfer || []); }catch(e){}
    }
    function enterHosted(){
      if(host.on) return;
      host.on = true;
      clearTimeout(autoLinkTimer); autoLinkTimer = null;
      if(net.code) leaveRoom();
      if(linked) setLinked(false, true);     // for this session only; the saved Link setting is kept
      if(playing && o.stop) withApplying(function(){ o.stop(true); }); // Discobot starts it on its own beat
      (o.hostHide || []).forEach(function(sel){
        Array.prototype.forEach.call(document.querySelectorAll(sel), function(el){ el.style.display = 'none'; });
      });
      syncHostAudio();
    }
    function onHostMessage(e){
      if(e.source !== global.parent) return;
      var m = e.data;
      if(!m || typeof m !== 'object' || m.discobotGuest !== GUEST_PROTOCOL || typeof m.type !== 'string') return;
      if(host.origin === null){
        if(m.type !== 'hello' || m.host !== 'discobot') return; // hosted mode starts with a valid hello
        host.origin = e.origin;
      } else if(e.origin !== host.origin) return;
      switch(m.type){
        case 'hello':
          if(m.host !== 'discobot') return;
          var lat = Number(m.latencyMs);
          host.latencyMs = isFinite(lat) ? Math.max(0, Math.min(1000, lat)) : 0;
          enterHosted();
          break;
        case 'transport': hostTransport(m); break;
        case 'getState':
          if(typeof m.id === 'string' && m.id.length <= 256) hostGetState(m.id);
          break;
        case 'setState': hostSetState(m.state); break;
        case 'audio':
          if(typeof m.on !== 'boolean') return;
          host.audio = m.on;
          syncHostAudio();
          break;
        default: return;
      }
      refreshUI();
    }
    function hostTransport(m){
      if(m.playing === false){
        host.playing = false;
        if(playing && o.stop) withApplying(function(){ o.stop(true); });
        return;
      }
      if(m.playing !== true) return;
      var bpm = Number(m.bpm), aw = Number(m.anchorWall), ab = Number(m.anchorBeat);
      if(!isFinite(bpm) || bpm < 1 || bpm > 1000 || !isFinite(aw) || !isFinite(ab) || ab < 0) return;
      var seg = { bpm: bpm, anchorWall: aw, anchorBeat: ab };
      if(!host.playing){
        // Start. The tempo is followed exactly, whatever this app's own control allows.
        host.playing = true; host.segs = [seg]; host.startBeat = ab;
        withApplying(function(){
          if(feat.tempo) o.applyBpm(bpm);
          if(playing && o.stop) o.stop(true);
          if(o.start) o.start(true);
        });
      } else {
        // Tempo change while playing: the beat count carries on.
        host.segs = insertSeg(host.segs, seg);
        if(playing) mySegs = insertSeg(mySegs, seg);
        if(feat.tempo) withApplying(function(){ o.applyBpm(bpm); });
      }
    }
    function hostGetState(reqId){
      var state = null;
      if(o.scene){ try{ state = JSON.parse(JSON.stringify(o.scene.capture())); }catch(e){ state = null; } }
      hostSend({ type:'state', id: reqId, state: state });
    }
    // Sets what is on screen only: nothing goes into saved scenes or the app's saved patterns.
    function hostSetState(state){
      if(!o.scene || !state || typeof state !== 'object' || Array.isArray(state)) return;
      withApplying(function(){
        try{ o.scene.apply(state); }catch(e){ if(global.console) console.warn('Jam Link: could not apply the settings from Discobot', e); }
        if(feat.tempo && host.playing && hostBpm() !== null) o.applyBpm(hostBpm());
      });
    }
    // The app connects its output here instead of to ctx.destination. Its gain is 1 except while
    // Discobot carries the sound, when the page's own speakers are silent.
    function speakers(){
      var c = ctx();
      if(!c) return null;
      if(!monitor || monitor.context !== c){
        monitor = c.createGain();
        monitor.gain.value = host.on && host.audio ? 0 : 1;
        monitor.connect(c.destination);
        if(host.on && host.audio) syncHostAudio();
      }
      return monitor;
    }
    function syncHostAudio(){
      var want = host.on && host.audio;
      if(monitor){ try{ monitor.gain.value = want ? 0 : 1; }catch(e){} }
      if(!want){ stopPcm(); return; }
      var c = ctx();
      if(!c || !c.audioWorklet || typeof AudioWorkletNode === 'undefined') return;
      if(pcm.ctx === c) return;              // running, or starting
      stopPcm();
      pcm.ctx = c;
      if(!pcm.ready || pcm.ready.ctx !== c){
        var url = URL.createObjectURL(new Blob([GUEST_TAP_SRC], { type:'application/javascript' }));
        pcm.ready = { ctx: c, promise: c.audioWorklet.addModule(url) };
      }
      pcm.ready.promise.then(function(){
        if(!(host.on && host.audio) || pcm.ctx !== c || pcm.node) return;
        var node = new AudioWorkletNode(c, 'jam-guest-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        node.port.onmessage = function(ev){
          var d = ev.data;
          if(pcm.node !== node) return;
          // When the block's first sample would have been heard on this page (no trim, no latency).
          hostSend({ type:'audio', wall: wallAtCtx(d.frame / c.sampleRate), sampleRate: c.sampleRate, left: d.l, right: d.r }, [d.l.buffer, d.r.buffer]);
          pcm.blocks++;
        };
        tappedNodes.forEach(function(n){ if(n.context === c){ try{ n.connect(node); }catch(e){} } });
        node.connect(c.destination);         // outputs silence; this only keeps the tap running
        pcm.node = node;
      }).catch(function(err){
        if(pcm.ctx === c) pcm.ctx = null;
        pcm.ready = null;
        if(global.console) console.warn('Jam Link: could not start sending sound to Discobot', err);
      });
    }
    function stopPcm(){
      var node = pcm.node;
      if(node){
        tappedNodes.forEach(function(n){ try{ n.disconnect(node); }catch(e){} });
        try{ node.port.onmessage = null; node.disconnect(); }catch(e){}
      }
      pcm.node = null; pcm.ctx = null;
    }
    // Tell Discobot soon after the user changes something, at most about once a second.
    var changeTimer = null;
    function noteUserChange(e){
      if(!host.on || applying || !e.isTrusted) return;
      if(ui && ui.root && e.target && e.target.nodeType && ui.root.contains(e.target)) return;
      if(changeTimer) return;
      changeTimer = setTimeout(function(){ changeTimer = null; if(host.on) hostSend({ type:'stateChanged' }); }, 1000);
    }
    // If the browser keeps sound blocked in the frame, one click inside it fixes it for the session.
    var unlockEl = null;
    function refreshUnlock(){
      if(!host.on || typeof document === 'undefined' || !document.body) return;
      var c = ctx();
      var need = !!(host.playing && c && c.state !== 'running');
      if(need && !unlockEl){
        unlockEl = document.createElement('button');
        unlockEl.type = 'button';
        unlockEl.textContent = 'Click here to enable sound';
        unlockEl.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483001;padding:8px 16px;border-radius:6px;border:1px solid #3a78c2;background:#3a78c2;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)';
        unlockEl.addEventListener('click', function(){
          if(o.unlock) o.unlock();
          var cc = ctx(); if(cc && cc.state !== 'running' && cc.resume) cc.resume();
          if(host.playing && !playing && o.start) withApplying(function(){ o.start(true); });
          setTimeout(refreshUnlock, 200);
        });
        document.body.appendChild(unlockEl);
      }
      if(unlockEl) unlockEl.style.display = need ? '' : 'none';
    }

    /* ---- UI ---- */
    var CSS = [
      '.jam-dock{position:fixed;left:50%;bottom:0;transform:translateX(-50%);width:min(1000px,100%);z-index:2147483000;font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--label,var(--ink,#222));pointer-events:none}',
      '.jam-dock *{box-sizing:border-box}.jam-dock>*{pointer-events:auto}',
      '.jam-tabrow{display:flex;justify-content:center}',
      '.jam-tab{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--line,rgba(128,128,128,.55));border-bottom:none;border-radius:9px 9px 0 0;background:var(--panel,#fff);color:inherit;font:inherit;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;font-size:11px;cursor:pointer;box-shadow:0 -2px 8px rgba(0,0,0,.12)}',
      '.jam-tab:hover{border-color:#3a78c2}.jam-tab .jam-led{width:8px;height:8px;border-radius:50%;background:rgba(128,128,128,.6)}',
      '.jam-tab.on .jam-led{background:#3fbf6f;box-shadow:0 0 6px #3fbf6f}.jam-tab .jam-sum{font-weight:500;letter-spacing:0;text-transform:none;opacity:.75}',
      '.jam-tab .jam-caret{opacity:.6;font-size:9px}',
      '.jam-panel{display:none;background:var(--panel,#fff);border:1px solid var(--line,rgba(128,128,128,.55));border-bottom:none;border-radius:10px 10px 0 0;box-shadow:0 -6px 22px rgba(0,0,0,.2);max-height:min(72vh,520px);overflow:auto;padding:10px}',
      '.jam-dock.open .jam-panel{display:block}',
      '.jam-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}',
      '.jam-group{border:1px solid var(--line,rgba(128,128,128,.4));border-top:3px solid #3a78c2;border-radius:6px;background:rgba(128,128,128,.07);padding:8px 10px}',
      '.jam-group.g-online{border-top-color:#2a9bbf}.jam-group.g-scenes{border-top-color:#b5498f}',
      '.jam-title{display:block;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;font-size:10.5px;opacity:.85;margin-bottom:6px}',
      '.jam-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}',
      '.jam-dock button{font:inherit;font-weight:600;padding:4px 10px;border-radius:5px;border:1px solid var(--line,rgba(128,128,128,.55));background:rgba(128,128,128,.14);color:inherit;cursor:pointer}',
      '.jam-dock button.jam-tab{padding:6px 14px;border-radius:9px 9px 0 0;border-bottom:none;background:var(--panel,#fff)}',
      '.jam-dock button.jam-on{background:#3a78c2;border-color:#3a78c2;color:#fff}.jam-dock button:disabled{opacity:.45;cursor:default}',
      '.jam-status{opacity:.8}.jam-opts{margin-top:6px}.jam-opts label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}',
      '.jam-opts input{accent-color:#3a78c2;margin:0}',
      '.jam-dock input[type=text]{flex:1 1 90px;min-width:80px;padding:4px 7px;border-radius:5px;border:1px solid var(--line,rgba(128,128,128,.55));background:rgba(128,128,128,.1);color:inherit;font:inherit}',
      '.jam-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}',
      '.jam-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 5px 2px 9px;border-radius:12px;border:1px solid var(--line,rgba(128,128,128,.55));background:rgba(128,128,128,.12);cursor:pointer}',
      '.jam-chip:hover{border-color:#3a78c2}.jam-dock .jam-chip .jam-x{padding:0 4px;border:none;background:transparent;opacity:.7}',
      '.jam-hint{opacity:.7;margin-top:5px;font-size:11px}'
    ].join('');

    function mountUI(){
      if(typeof document === 'undefined' || !document.body) return;
      if(!document.getElementById('jam-css')){
        var st = document.createElement('style'); st.id = 'jam-css'; st.textContent = CSS; document.head.appendChild(st);
      }
      var root = document.createElement('div'); root.className = 'jam-dock';
      var opts = [['tempo','Tempo'],['transport','Start / stop'],['key','Key & mode'],['scenes','Scenes']].filter(function(p){ return feat[p[0] === 'transport' ? 'transport' : p[0]]; });
      root.innerHTML =
        '<div class="jam-tabrow"><button type="button" class="jam-tab" aria-expanded="false"><span class="jam-led"></span>Jam link<span class="jam-sum"></span><span class="jam-caret">&#9650;</span></button></div>' +
        '<div class="jam-panel"><div class="jam-grid">' +
        '<div class="jam-group g-link"><span class="jam-title">Link</span>' +
        '<div class="jam-row"><button type="button" class="jam-toggle"></button><span class="jam-status"></span></div>' +
        '<div class="jam-row jam-opts">' + opts.map(function(p){ return '<label><input type="checkbox" data-k="' + p[0] + '"> ' + p[1] + '</label>'; }).join('') + '</div>' +
        '<div class="jam-row" style="margin-top:6px"><label for="jam-trim-' + o.app + '">Sync trim</label><input type="range" id="jam-trim-' + o.app + '" class="jam-trim" min="-80" max="80" step="1" style="width:120px;accent-color:#3a78c2"><span class="jam-trimval"></span></div>' +
        '<div class="jam-hint jam-help"></div></div>' +
        '<div class="jam-group g-online"><span class="jam-title">Online</span>' +
        '<div class="jam-row"><input type="text" class="jam-name" placeholder="Your name" maxlength="16">' +
        '<button type="button" class="jam-create">Create room</button>' +
        '<input type="text" class="jam-code" placeholder="Room code" maxlength="8" style="text-transform:uppercase">' +
        '<button type="button" class="jam-join">Join</button><button type="button" class="jam-leave" style="display:none">Leave</button></div>' +
        '<div class="jam-roominfo jam-row" style="display:none;margin-top:6px"></div><div class="jam-netpeers"></div>' +
        '<div class="jam-hint jam-netstatus">Play with people elsewhere: one of you creates a room and shares the code or link, the others join. Each runs one app and you hear each other\'s. Anyone with the code can listen in.</div></div>' +
        (feat.scenes && o.scene ? '<div class="jam-group g-scenes jam-scenes"><span class="jam-title">Scenes</span><div class="jam-row"><input type="text" class="jam-scene-name" placeholder="Scene name"><button type="button" class="jam-scene-save">Save scene</button></div><div class="jam-chips"></div><div class="jam-hint jam-scene-note">A scene stores every linked app\'s current pattern, plus tempo and key. Click one to recall it everywhere.</div></div>' : '') +
        '</div></div>';
      document.body.appendChild(root);
      var setPad = function(){ var h = root.querySelector('.jam-tabrow').offsetHeight || 30; document.body.style.paddingBottom = Math.max(parseFloat(getComputedStyle(document.body).paddingBottom) || 0, h + 14) + 'px'; };
      setPad();
      ui = { root: root, tab: root.querySelector('.jam-tab'), sum: root.querySelector('.jam-sum'),
        toggle: root.querySelector('.jam-toggle'), status: root.querySelector('.jam-status'),
        help: root.querySelector('.jam-help'), sceneNote: root.querySelector('.jam-scene-note'),
        nameEl: root.querySelector('.jam-name'), createBtn: root.querySelector('.jam-create'), codeEl: root.querySelector('.jam-code'),
        joinBtn: root.querySelector('.jam-join'), leaveBtn: root.querySelector('.jam-leave'), roomInfo: root.querySelector('.jam-roominfo'),
        netPeers: root.querySelector('.jam-netpeers'), netStatus: root.querySelector('.jam-netstatus'), peerSig: '',
        sceneName: root.querySelector('.jam-scene-name'), sceneSave: root.querySelector('.jam-scene-save'),
        chips: root.querySelector('.jam-chips'), scenes: root.querySelector('.jam-scenes') };
      var setOpen = function(on){ root.classList.toggle('open', on); ui.tab.setAttribute('aria-expanded', on ? 'true' : 'false'); root.querySelector('.jam-caret').innerHTML = on ? '&#9660;' : '&#9650;'; };
      ui.tab.addEventListener('click', function(){ setOpen(!root.classList.contains('open')); });
      document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && root.classList.contains('open')) setOpen(false); });
      ui.setOpen = setOpen;
      ui.toggle.addEventListener('click', function(){ if(linked && net.code) leaveRoom(); setLinked(!linked); });
      ui.nameEl.value = displayName;
      ui.nameEl.addEventListener('input', function(){ displayName = ui.nameEl.value.trim(); prefSet('name', displayName); });
      ui.createBtn.addEventListener('click', createRoom);
      ui.joinBtn.addEventListener('click', function(){ joinRoom(ui.codeEl.value); });
      ui.codeEl.addEventListener('keydown', function(e){ if(e.key === 'Enter') joinRoom(ui.codeEl.value); });
      ui.leaveBtn.addEventListener('click', leaveRoom);
      Array.prototype.forEach.call(root.querySelectorAll('input[data-k]'), function(cb){
        cb.checked = !!follow[cb.dataset.k];
        cb.addEventListener('change', function(){ setFollow(cb.dataset.k, cb.checked); });
      });
      if(ui.sceneSave){
        ui.sceneSave.addEventListener('click', function(){
          var name = (ui.sceneName.value || '').trim() || ('Scene ' + (readScenes().length + 1));
          ui.sceneSave.disabled = true;
          saveScene(name, function(apps){
            ui.sceneSave.disabled = false; ui.sceneName.value = '';
            ui.sceneNote.textContent = 'Saved "' + name + '" with ' + apps.map(function(a){ return APP_NAMES[a] || a; }).join(', ') + '.';
          });
        });
      }
      var trimEl = root.querySelector('.jam-trim'), trimVal = root.querySelector('.jam-trimval');
      var showTrim = function(){ trimVal.textContent = (trimMs > 0 ? '+' : '') + trimMs + ' ms'; };
      trimEl.value = trimMs; showTrim();
      trimEl.title = 'Nudge this app earlier or later if it sounds slightly off the others (for example with a Bluetooth speaker)';
      trimEl.addEventListener('input', function(){ trimMs = parseInt(trimEl.value, 10) || 0; prefSet('trim', trimMs); showTrim(); });
      global.addEventListener('storage', function(e){ if(e.key === SCENES_KEY) renderScenes(); });
      uiTimer = setInterval(refreshUI, 1000);
      renderScenes();
      refreshUI();
    }
    function renderScenes(){
      if(!ui || !ui.chips) return;
      ui.chips.innerHTML = '';
      readScenes().forEach(function(s){
        var chip = document.createElement('span'); chip.className = 'jam-chip';
        var label = document.createElement('span');
        var apps = Object.keys(s.parts).map(function(a){ return APP_NAMES[a] || a; }).join(' + ');
        label.textContent = s.name; label.title = apps + (s.bpm ? ' · ' + Math.round(s.bpm) + ' bpm' : '');
        label.addEventListener('click', function(){ loadScene(s.id); });
        var x = document.createElement('button'); x.type = 'button'; x.className = 'jam-x'; x.textContent = '✕'; x.title = 'Delete';
        x.addEventListener('click', function(e){ e.stopPropagation(); deleteScene(s.id); });
        chip.appendChild(label); chip.appendChild(x); ui.chips.appendChild(chip);
      });
    }
    function inviteLink(){
      var u = new URL(global.location.href); u.search = ''; u.hash = '';
      return u.href + '?jam=' + net.code;
    }
    function copyText(text, btn){
      var done = function(){ var old = btn.textContent; btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = old; }, 1200); };
      if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function(){ global.prompt('Copy this:', text); });
      else global.prompt('Copy this:', text);
    }
    function refreshOnline(){
      var inRoom = !!net.code;
      ui.createBtn.style.display = inRoom ? 'none' : ''; ui.codeEl.style.display = inRoom ? 'none' : ''; ui.joinBtn.style.display = inRoom ? 'none' : '';
      ui.leaveBtn.style.display = inRoom ? '' : 'none';
      ui.roomInfo.style.display = inRoom ? '' : 'none';
      if(inRoom && ui.roomInfo.dataset.code !== net.code){
        ui.roomInfo.dataset.code = net.code;
        ui.roomInfo.innerHTML = '<span>Room</span><b class="jam-roomcode" style="font-size:16px;letter-spacing:2px"></b><button type="button" class="jam-copycode">Copy code</button><button type="button" class="jam-copylink">Copy link</button>';
        ui.roomInfo.querySelector('.jam-roomcode').textContent = net.code;
        ui.roomInfo.querySelector('.jam-copycode').addEventListener('click', function(e){ copyText(net.code, e.target); });
        ui.roomInfo.querySelector('.jam-copylink').addEventListener('click', function(e){ copyText(inviteLink(), e.target); });
      }
      if(!inRoom) ui.roomInfo.dataset.code = '';
      var list = netOpenEntries();
      var sig = list.map(function(e){ return e.slot + ':' + e.muted; }).join(',') + '|' + Object.keys(peers).map(function(k){ return peers[k].name + peers[k].app; }).join(',');
      if(sig !== ui.peerSig){
        ui.peerSig = sig;
        ui.netPeers.innerHTML = '';
        list.forEach(function(e){
          var p = Object.keys(peers).map(function(k){ return peers[k]; }).filter(function(x){ return x.net === e; })[0];
          var row = document.createElement('div'); row.className = 'jam-row'; row.style.marginTop = '5px'; row.dataset.slot = e.slot;
          var who = document.createElement('span'); who.style.minWidth = '110px';
          who.textContent = ((p && p.name) ? p.name + ' · ' : '') + (p ? (APP_NAMES[p.app] || p.app) : 'connecting…');
          var rtt = document.createElement('span'); rtt.className = 'jam-rtt'; rtt.style.opacity = '.7'; rtt.style.minWidth = '64px';
          var vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = Math.round(e.vol * 100); vol.style.width = '80px'; vol.style.accentColor = '#3a78c2';
          vol.addEventListener('input', function(){ setPeerVolume(e.slot, vol.value / 100); });
          var mute = document.createElement('button'); mute.type = 'button'; mute.textContent = e.muted ? 'Unmute' : 'Mute';
          mute.addEventListener('click', function(){ setPeerMuted(e.slot, !e.muted); ui.peerSig = ''; refreshOnline(); });
          row.appendChild(who); row.appendChild(rtt); row.appendChild(vol); row.appendChild(mute);
          ui.netPeers.appendChild(row);
        });
      }
      list.forEach(function(e){ var r = ui.netPeers.querySelector('[data-slot="' + e.slot + '"] .jam-rtt'); if(r) r.textContent = e.rtt ? Math.round(e.rtt) + ' ms' : '…'; });
      if(inRoom){
        ui.netStatus.textContent = net.slot < 0 ? net.status : list.length ? 'In room ' + net.code + '. You hear each other\'s apps; the latency shown is the round trip to each person.' : net.status;
      } else if(net.status) ui.netStatus.textContent = net.status;
    }
    function refreshUI(){
      if(!ui) return;
      ui.toggle.textContent = linked ? 'Linked' : 'Link off';
      ui.tab.classList.toggle('on', linked);
      var nPeers = peerList().length;
      ui.sum.textContent = !linked ? 'off' : (net.code ? net.code + ' · ' : '') + (nPeers ? nPeers + (nPeers === 1 ? ' app' : ' apps') : 'linked');
      ui.toggle.classList.toggle('jam-on', linked);
      var names = peerList().map(function(p){ return APP_NAMES[p.app] || p.app; });
      ui.status.textContent = !linked ? 'Not sharing with other apps.'
        : names.length ? 'With ' + names.join(', ') + (anyPeerPlaying() ? ' (playing)' : '')
        : 'Waiting for another app. Open one in another tab and press Link there too.';
      Array.prototype.forEach.call(ui.root.querySelectorAll('input[data-k]'), function(cb){ cb.checked = !!follow[cb.dataset.k]; });
      if(ui.scenes) ui.scenes.style.display = '';
      refreshOnline();
      ui.help.textContent = linked && follow.transport && feat.transport ? 'Start or stop any linked app and the others follow. An app that joins while others play comes in on the next bar.' : '';
      if(host.on) refreshHostedUI();
    }
    function refreshHostedUI(){
      ui.toggle.textContent = 'Hosted'; ui.toggle.disabled = true;
      ui.toggle.classList.add('jam-on'); ui.tab.classList.add('on');
      ui.sum.textContent = 'Discobot' + (host.playing ? ' · playing' : '');
      ui.status.textContent = 'In a Discobot rack. Link is off while hosted: Discobot sets the tempo and starts and stops this app' + (host.audio ? ', and plays its sound.' : '.');
      ui.help.textContent = host.audio ? 'Sync trim is not used while Discobot plays the sound.' : '';
      [ui.createBtn, ui.joinBtn, ui.codeEl].forEach(function(el){ if(el) el.disabled = true; });
      Array.prototype.forEach.call(ui.root.querySelectorAll('input[data-k]'), function(cb){ cb.disabled = true; });
      ui.netStatus.textContent = 'Online rooms are off while this app is in a Discobot rack.';
      refreshUnlock();
    }

    var api = {
      id: id, app: o.app,
      begin: begin, end: end, timeOfBeat: timeOfBeat, beatAt: beatAt, bpm: bpmNow,
      userTempo: userTempo, userKey: userKey,
      tapAudio: tapAudio, speakers: speakers, get hosted(){ return host.on; }, joinRoom: joinRoom, createRoom: createRoom, leaveRoom: leaveRoom, get room(){ return net.code; },
      get linked(){ return linked; }, get applying(){ return applying; }, get playing(){ return playing; },
      setLinked: setLinked, setFollow: setFollow,
      saveScene: saveScene, loadScene: loadScene, scenes: readScenes,
      diag: function(){ var c = ctx(); return c ? { now: wallNow(), heard: wallAtCtx(c.currentTime), state: c.state, outLat: c.outputLatency, baseLat: c.baseLatency } : null; },
      trace: function(ctxTime, tag){ if(global.__jamTrace) global.__jamTrace.push({ app: o.app, tag: tag, wall: wallAtCtx(ctxTime) }); },
      debug: function(){ return { mySegs: mySegs, sharedSegs: sharedSegs, originBeat: originBeat, peers: peers,
        host: { on: host.on, origin: host.origin, latencyMs: host.latencyMs, audio: host.audio, playing: host.playing, segs: host.segs, blocksSent: pcm.blocks }, net: Object.keys(net.entries).map(function(k){ var e = net.entries[k]; return { slot: e.slot, open: e.open, off: e.off, rtt: e.rtt, hasAudio: !!e.audio, ignore: e.ignore }; }) }; }
    };
    global.jamLink = api; // handy for debugging in the console
    mountUI();
    // In a frame, give Discobot a moment to say hello before restoring the saved Link setting.
    var autoLinkTimer = null;
    if(prefGet('linked', false)){
      if(framed) autoLinkTimer = setTimeout(function(){ autoLinkTimer = null; if(!host.on) setLinked(true); }, HOST_WAIT_MS);
      else setLinked(true);
    }
    if(framed){
      global.addEventListener('message', onHostMessage);
      ['input', 'change', 'click'].forEach(function(t){ document.addEventListener(t, noteUserChange, true); });
      hostSend({ type:'ready', name: o.title || FULL_NAMES[o.app] || o.app, features: o.scene ? ['transport', 'state', 'audio'] : ['transport', 'audio'] });
    }
    global.addEventListener('beforeunload', function(){ if(linked) send({ t:'bye' }); try{ if(net.peer) net.peer.destroy(); }catch(e){} });
    try{
      var wanted = new URLSearchParams(global.location.search).get('jam');
      if(wanted && o.mount) setTimeout(function(){ joinRoom(wanted); }, 0);
    }catch(e){}
    return api;
  }
  global.Jam = { create: create, BPM_MIN: BPM_MIN, BPM_MAX: BPM_MAX };
})(typeof window !== 'undefined' ? window : globalThis);
