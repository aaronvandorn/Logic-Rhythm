/* ===== JAM LINK — shared transport for Logic Rhythm, Boolean Melody Machine and Choir =====
   One identical copy of this block is embedded in each app (between the JAM-LINK markers).
   Apps in different tabs/windows of the same browser talk over a BroadcastChannel, so they must be
   served from the same origin (they are: aaronvandorn.github.io).

   Timing: every tab has its own AudioContext clock, so the shared timeline lives on the wall clock
   (performance.timeOrigin + performance.now()). A transport is a list of tempo "segments"
   { bpm, anchorWall, anchorBeat }: beat b happens at anchorWall + (b - anchorBeat) * 60000 / bpm.
   Tempo changes start a new segment that begins slightly in the future, so every app has the same
   mapping from beats to time and nobody drifts. Each app converts that wall time into its own
   AudioContext time with getOutputTimestamp(). */
(function(global){
  'use strict';
  var CHANNEL_NAME = 'aaronvandorn-jam-v1';
  var SCENES_KEY = 'aaronvandornJamScenes';
  var LEAD_MS = 150;        // how far ahead a shared start or tempo change is placed
  var JOIN_LEAD_MS = 70;    // minimum time needed to start an app that is joining
  var BAR_BEATS = 4;        // late joiners enter on the next multiple of this many beats
  var HB_MS = 1500, PEER_TTL_MS = 5000, SCENE_WAIT_MS = 700;
  var BPM_MIN = 40, BPM_MAX = 240;
  var APP_NAMES = { choir:'Choir', logic:'Logic Rhythm', bmm:'Melody Machine' };

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
    var follow = { tempo: prefGet('tempo', true), transport: prefGet('transport', true), key: prefGet('key', true), scenes: prefGet('scenes', true) };
    var trimMs = prefGet('trim', 0); // fine phase adjustment for this app (ms, + = later)
    var mySegs = [], sharedSegs = [], originBeat = 0;
    var playing = false, applying = false;
    var sharedKey = null;
    var peers = {};
    var channel = null, hbTimer = null, uiTimer = null;
    var pendingScene = null;
    var ui = null;

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
    // Local beat 0 is the moment this app started. These are what the apps schedule against.
    function timeOfBeat(localBeat){
      if(!mySegs.length) return ctx() ? ctx().currentTime : 0;
      return ctxAtWall(beatToWall(mySegs, originBeat + localBeat)) + trimMs / 1000;
    }
    function beatAt(ctxTime){
      if(!mySegs.length) return 0;
      return wallToBeat(mySegs, wallAtCtx(ctxTime) - trimMs) - originBeat;
    }
    function bpmNow(){
      if(playing && mySegs.length) return mySegs[mySegs.length-1].bpm;
      return o.bpm();
    }

    /* ---- messaging ---- */
    function send(msg){
      if(!linked) return;
      msg.v = 1; msg.from = id; msg.app = o.app;
      if(channel){ try{ channel.postMessage(msg); }catch(e){} }
      else { try{ localStorage.setItem('jam:msg', JSON.stringify({ n: Math.random(), m: msg })); }catch(e){} }
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
      if(m.t !== 'bye') peers[m.from] = { id: m.from, app: m.app, playing: !!(m.t === 'play' ? m.playing : (peers[m.from] && peers[m.from].playing)), ts: wallNow() };
      switch(m.t){
        case 'hello':
          send({ t:'welcome', to: m.from, playing: playing, bpm: bpmNow(), segs: playing ? mySegs : sharedSegs, key: sharedKey || currentKey() });
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
    function canAutoplay(){ return typeof navigator === 'undefined' || !navigator.userActivation || navigator.userActivation.hasBeenActive; }

    function currentKey(){ return feat.key && o.key ? o.key.get() : null; }
    function applyKey(k){ if(feat.key && o.key && k) withApplying(function(){ o.key.set(k); }); }

    /* ---- what the apps call ---- */
    function begin(remote){
      var now = wallNow();
      var share = linked && follow.transport && feat.transport;
      var join = share && sharedSegs.length && (remote || anyPeerPlaying());
      if(join){
        var nb = Math.max(0, Math.ceil(wallToBeat(sharedSegs, now + JOIN_LEAD_MS) / BAR_BEATS - 1e-9) * BAR_BEATS);
        var wallStart = beatToWall(sharedSegs, nb);
        originBeat = nb;
        mySegs = (follow.tempo && feat.tempo) ? sharedSegs.slice()
               : [{ bpm: clampBpm(o.bpm()), anchorWall: wallStart, anchorBeat: nb }];
      } else if(share){
        var seg = { bpm: clampBpm(o.bpm()), anchorWall: now + LEAD_MS, anchorBeat: 0 };
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
        if(playing) mySegs = insertSeg(mySegs, makeSeg(mySegs, bpm, LEAD_MS));
        return;
      }
      var seg = makeSeg(base, bpm, playing || anyPeerPlaying() ? LEAD_MS : 0);
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
      if(linked) send({ t:'scene-load', sceneId: sid });
    }
    function deleteScene(sid){ writeScenes(readScenes().filter(function(s){ return s.id !== sid; })); renderScenes(); }

    /* ---- link on/off ---- */
    function setLinked(on){
      if(on === linked) return;
      if(on){
        linked = true;
        if(typeof BroadcastChannel !== 'undefined'){
          channel = new BroadcastChannel(CHANNEL_NAME);
          channel.onmessage = function(e){ onMessage(e.data); };
        } else {
          global.addEventListener('storage', storageHandler);
        }
        send({ t:'hello' });
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
      prefSet('linked', on);
      refreshUI();
    }
    function storageHandler(e){
      if(e.key !== 'jam:msg' || !e.newValue) return;
      try{ onMessage(JSON.parse(e.newValue).m); }catch(err){}
    }
    function setFollow(k, on){ follow[k] = on; prefSet(k, on); refreshUI(); }

    /* ---- UI ---- */
    var CSS = '.jam{margin:14px 0;padding:12px 14px;border:1px solid rgba(128,128,128,.4);border-radius:8px;background:rgba(128,128,128,.07);font-size:12px;line-height:1.5;color:inherit;font-family:inherit}' +
      '.jam *{box-sizing:border-box}.jam-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}' +
      '.jam-title{font-weight:700;letter-spacing:1.2px;text-transform:uppercase;font-size:11px;opacity:.8}' +
      '.jam button{font:inherit;font-weight:600;padding:6px 12px;border-radius:5px;border:1px solid rgba(128,128,128,.5);background:rgba(128,128,128,.14);color:inherit;cursor:pointer}' +
      '.jam button.jam-on{background:#3a78c2;border-color:#3a78c2;color:#fff}' +
      '.jam button:disabled{opacity:.45;cursor:default}' +
      '.jam-status{opacity:.8}.jam-opts label{display:inline-flex;align-items:center;gap:4px;margin-right:10px;cursor:pointer}' +
      '.jam-opts input{accent-color:#3a78c2;margin:0}' +
      '.jam-scenes{margin-top:10px;padding-top:10px;border-top:1px solid rgba(128,128,128,.3)}' +
      '.jam input[type=text]{flex:1 1 150px;min-width:120px;padding:6px 8px;border-radius:5px;border:1px solid rgba(128,128,128,.5);background:rgba(128,128,128,.1);color:inherit;font:inherit}' +
      '.jam-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
      '.jam-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 6px 3px 10px;border-radius:14px;border:1px solid rgba(128,128,128,.5);background:rgba(128,128,128,.12);cursor:pointer}' +
      '.jam-chip:hover{border-color:#3a78c2}.jam-chip .jam-x{padding:0 4px;border:none;background:transparent;opacity:.7}' +
      '.jam-hint{opacity:.7;margin-top:6px}';

    function mountUI(){
      if(!o.mount || typeof document === 'undefined') return;
      if(!document.getElementById('jam-css')){
        var st = document.createElement('style'); st.id = 'jam-css'; st.textContent = CSS; document.head.appendChild(st);
      }
      var root = document.createElement('div'); root.className = 'jam';
      var opts = [['tempo','Tempo'],['transport','Start / stop'],['key','Key & mode'],['scenes','Scenes']].filter(function(p){ return feat[p[0] === 'transport' ? 'transport' : p[0]]; });
      root.innerHTML =
        '<div class="jam-row"><span class="jam-title">Jam link</span>' +
        '<button type="button" class="jam-toggle"></button>' +
        '<span class="jam-status"></span></div>' +
        '<div class="jam-row jam-opts" style="margin-top:8px">' +
        opts.map(function(p){ return '<label><input type="checkbox" data-k="' + p[0] + '"> ' + p[1] + '</label>'; }).join('') + '</div>' +
        '<div class="jam-row jam-trimrow" style="margin-top:8px"><label for="jam-trim-' + o.app + '">Sync trim</label><input type="range" id="jam-trim-' + o.app + '" class="jam-trim" min="-80" max="80" step="1" style="width:160px;accent-color:#3a78c2"><span class="jam-trimval"></span></div>' +
        '<div class="jam-hint jam-help"></div>' +
        (feat.scenes && o.scene ? '<div class="jam-scenes"><div class="jam-row"><input type="text" class="jam-scene-name" placeholder="Scene name"><button type="button" class="jam-scene-save">Save scene</button></div><div class="jam-chips"></div><div class="jam-hint jam-scene-note">A scene stores the current pattern of every linked app, plus tempo and key. Click one to recall it everywhere.</div></div>' : '');
      o.mount.appendChild(root);
      ui = { root: root,
        toggle: root.querySelector('.jam-toggle'), status: root.querySelector('.jam-status'),
        help: root.querySelector('.jam-help'), sceneNote: root.querySelector('.jam-scene-note'),
        sceneName: root.querySelector('.jam-scene-name'), sceneSave: root.querySelector('.jam-scene-save'),
        chips: root.querySelector('.jam-chips'), scenes: root.querySelector('.jam-scenes') };
      ui.toggle.addEventListener('click', function(){ setLinked(!linked); });
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
    function refreshUI(){
      if(!ui) return;
      ui.toggle.textContent = linked ? 'Linked' : 'Link off';
      ui.toggle.classList.toggle('jam-on', linked);
      var names = peerList().map(function(p){ return APP_NAMES[p.app] || p.app; });
      ui.status.textContent = !linked ? 'Not sharing with other apps.'
        : names.length ? 'With ' + names.join(', ') + (anyPeerPlaying() ? ' (playing)' : '')
        : 'Waiting for another app. Open one in another tab and press Link there too.';
      Array.prototype.forEach.call(ui.root.querySelectorAll('input[data-k]'), function(cb){ cb.checked = !!follow[cb.dataset.k]; });
      if(ui.scenes) ui.scenes.style.display = linked ? '' : 'none';
      ui.help.textContent = linked && follow.transport && feat.transport ? 'Start or stop any linked app and the others follow. An app that joins while others play comes in on the next bar.' : '';
    }

    var api = {
      id: id, app: o.app,
      begin: begin, end: end, timeOfBeat: timeOfBeat, beatAt: beatAt, bpm: bpmNow,
      userTempo: userTempo, userKey: userKey,
      get linked(){ return linked; }, get applying(){ return applying; }, get playing(){ return playing; },
      setLinked: setLinked, setFollow: setFollow,
      saveScene: saveScene, loadScene: loadScene, scenes: readScenes,
      diag: function(){ var c = ctx(); return c ? { now: wallNow(), heard: wallAtCtx(c.currentTime), state: c.state, outLat: c.outputLatency, baseLat: c.baseLatency } : null; },
      trace: function(ctxTime, tag){ if(global.__jamTrace) global.__jamTrace.push({ app: o.app, tag: tag, wall: wallAtCtx(ctxTime) }); },
      debug: function(){ return { mySegs: mySegs, sharedSegs: sharedSegs, originBeat: originBeat, peers: peers }; }
    };
    global.jamLink = api; // handy for debugging in the console
    mountUI();
    if(prefGet('linked', false)) setLinked(true);
    global.addEventListener('beforeunload', function(){ if(linked) send({ t:'bye' }); });
    return api;
  }
  global.Jam = { create: create, BPM_MIN: BPM_MIN, BPM_MAX: BPM_MAX };
})(typeof window !== 'undefined' ? window : globalThis);
