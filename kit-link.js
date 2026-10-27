/* ===== KIT LINK — send drum sounds from one app in the ecosystem to another =====
   One identical copy of this block is embedded in each app that sends or receives kits (between the
   KIT-LINK markers); kit-link.js is the source copy. Same browser and same site only: it talks over a
   BroadcastChannel, so it works between tabs of the apps on aaronvandorn.github.io.

   A sound is { name, role, data, mime }: data is a WAV file as an ArrayBuffer. role says what drum it is,
   so the receiver can put it on the right track: 'kick', 'snare', 'clap', 'closedHat', 'openHat', 'tom',
   'lowTom', 'highTom', 'cymbal', 'perc', 'fx', or null.

   Receiving (e.g. Logic Rhythm):
     KitLink.receiver({ app: 'logic', title: 'Logic Rhythm', onKit: function (kit, answer) {
       // kit = { sender, sounds }. Show the sounds to the user; nothing need be kept until they confirm.
       answer(n);   // when done: how many sounds were kept (0 = cancelled)
     } });

   Sending (e.g. Drum Foundry):
     KitLink.send({ to: 'logic', url: '/Logic-Rhythm/', sender: 'Drum Foundry', sounds: [...],
                    onStatus: function (state, info) {} });
     state: 'looking' | 'closed' (info.open) | 'opening' | 'sent' (info.title) | 'done' (info.imported)
            | 'blocked' | 'timeout'
     If no tab of the receiver answers within a moment, the state is 'closed' and info.open() opens the
     receiver's page in a new tab with #receive-kit (call it from a click); the kit goes once that tab is ready.

   Messages: { kv: 1, t, from, ... } on CHANNEL.
     sender   -> all       who    { app }                       is a receiver of this app open?
     receiver -> sender    here   { to, app, title }            answer to who, or unasked on load with #receive-kit
     sender   -> receiver  kit    { to, id, sender, sounds }
     receiver -> sender    got    { to, id }
     receiver -> sender    done   { to, id, imported }                                          */
(function (global) {
  'use strict';
  if (global.KitLink) return;
  var CHANNEL = 'aaronvandorn-kits-v1', KV = 1;
  var ASK_MS = 700, OPEN_WAIT_MS = 30000, MAX_SOUNDS = 64, MAX_BYTES = 16 * 1024 * 1024;
  var ROLES = ['kick', 'snare', 'clap', 'closedHat', 'openHat', 'tom', 'lowTom', 'highTom', 'cymbal', 'perc', 'fx'];
  function rid() { return Math.random().toString(36).slice(2, 10); }
  function open(onMsg) {
    if (typeof BroadcastChannel === 'undefined') return null;
    var ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = function (e) { var m = e.data; if (m && m.kv === KV && typeof m.t === 'string' && typeof m.from === 'string') onMsg(m); };
    return ch;
  }
  /* Everything a sender says is checked before an app sees it. */
  function cleanSounds(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_SOUNDS; i++) {
      var s = list[i];
      if (!s || !(s.data instanceof ArrayBuffer) || s.data.byteLength < 44 || s.data.byteLength > MAX_BYTES) continue;
      var name = String(typeof s.name === 'string' ? s.name : 'Sound').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 48) || 'Sound';
      out.push({ name: name, role: ROLES.indexOf(s.role) >= 0 ? s.role : null, data: s.data, mime: 'audio/wav' });
    }
    return out;
  }

  function receiver(o) {
    var id = rid(), busy = false;
    var ch = open(function (m) {
      if (m.t === 'who' && m.app === o.app) post({ t: 'here', to: m.from, app: o.app, title: o.title });
      else if (m.t === 'kit' && m.to === id) {
        var sounds = cleanSounds(m.sounds), sender = String(m.sender || 'Another app').slice(0, 40);
        post({ t: 'got', to: m.from, id: m.id });
        if (!sounds.length || busy) { post({ t: 'done', to: m.from, id: m.id, imported: 0 }); return; }
        busy = true;
        var answered = false;
        o.onKit({ sender: sender, sounds: sounds }, function (n) {
          if (answered) return; answered = true; busy = false;
          post({ t: 'done', to: m.from, id: m.id, imported: Math.max(0, Math.round(+n || 0)) });
        });
      }
    });
    function post(m) { if (ch) { m.kv = KV; m.from = id; ch.postMessage(m); } }
    var asked = false;
    try { asked = /^#receive-kit\b/.test(location.hash); if (asked) history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    if (asked) post({ t: 'here', to: '*', app: o.app, title: o.title });
    return { id: id };
  }

  function send(o) {
    var status = o.onStatus || function () {};
    var me = rid(), kitId = rid(), target = null, timer = 0, opened = false, sent = false;
    var ch = open(function (m) {
      if (m.t === 'here' && m.app === o.to && (m.to === me || (opened && m.to === '*')) && !target) {
        target = m.from; clearTimeout(timer);
        post({ t: 'kit', to: target, id: kitId, sender: o.sender, sounds: o.sounds });
        sent = true; status('sent', { title: m.title || o.to, opened: opened });
      } else if (m.t === 'done' && m.to === me && m.id === kitId) {
        clearTimeout(timer); status('done', { imported: m.imported }); close();
      }
    });
    function post(m) { m.kv = KV; m.from = me; ch.postMessage(m); }
    function close() { try { ch.close(); } catch (e) {} }
    if (!ch) { status('blocked', { reason: 'channel' }); return; }
    status('looking', {});
    post({ t: 'who', app: o.to });
    timer = setTimeout(function () {
      if (target) return;
      // No tab of the receiver is open. Opening one needs a click, so hand the app a function to call from one.
      status('closed', { open: function () {
        if (target || opened) return;
        var win = null;
        try { win = global.open(o.url + '#receive-kit', '_blank'); } catch (e) { win = null; }
        if (!win) { status('blocked', { reason: 'popup' }); close(); return; }
        opened = true; status('opening', {});
        timer = setTimeout(function () { if (!sent) { status('timeout', {}); close(); } }, OPEN_WAIT_MS);
      } });
    }, ASK_MS);
  }

  global.KitLink = { receiver: receiver, send: send, ROLES: ROLES, cleanSounds: cleanSounds };
})(typeof window !== 'undefined' ? window : globalThis);
