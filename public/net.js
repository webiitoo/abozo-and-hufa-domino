'use strict';

// Networking without a game server. The browser of the player who creates the room
// runs the game (DominoEngine) and friends connect to it directly over WebRTC.
// PeerJS's free public service is only used so the browsers can find each other.
window.Net = (function () {
  const PREFIX = 'abozo-hufa-domino-v1-';
  const HOST_SAVE_KEY = 'domino-host-room';
  const PEER_OPTIONS = { debug: 0 };

  const listeners = {};
  let mode = null; // 'host' | 'guest' | null
  let peer = null;
  let engine = null;
  const guests = new Map(); // host side: client id -> DataConnection
  let guestSeq = 0;
  let conn = null; // guest side: connection to the host
  let lastJoin = null; // guest side: details used to rejoin after a dropped connection
  let reqSeq = 0;
  const pending = new Map();

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); }
  function fire(event, data) { (listeners[event] || []).forEach((fn) => fn(data)); }

  function load(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function store(key, value) {
    try {
      if (value == null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
  }

  function send(c, msg) {
    try { if (c && c.open) c.send(msg); } catch (e) { /* connection is closing */ }
  }

  function makeCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(5);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join('');
  }

  function teardown() {
    conn = null; // first, so closing it below isn't treated as a dropped connection
    if (peer) {
      try { peer.destroy(); } catch (e) { /* ignore */ }
    }
    peer = null;
    engine = null;
    conn = null;
    mode = null;
    guests.clear();
    pending.clear();
  }

  // ---------- Host ----------

  function deliver(cid, event, data) {
    if (cid === 'local') {
      // Copy, so the host's screen gets a snapshot like guests do (not live engine arrays).
      // A microtask rather than setTimeout: timers are heavily throttled in background tabs.
      const snapshot = JSON.parse(JSON.stringify(data));
      Promise.resolve().then(() => fire(event, snapshot));
      return;
    }
    send(guests.get(cid), { t: 'ev', ev: event, data });
  }

  function openHost(roomId, saved) {
    return new Promise((resolve, reject) => {
      const p = new Peer(PREFIX + roomId, PEER_OPTIONS);
      let opened = false;

      p.on('open', () => {
        opened = true;
        peer = p;
        mode = 'host';
        engine = DominoEngine.create(roomId, saved, deliver, (room) => store(HOST_SAVE_KEY, JSON.stringify(room)));
        resolve();
      });

      p.on('connection', (c) => {
        const cid = 'g' + (++guestSeq);
        c.on('open', () => guests.set(cid, c));
        c.on('data', (msg) => {
          if (!msg || msg.t !== 'req' || !engine || mode !== 'host') return;
          const res = engine.handle(cid, msg.ev, msg.data);
          if (msg.id) send(c, { t: 'ack', id: msg.id, res: res || { ok: true } });
        });
        const gone = () => {
          if (guests.get(cid) !== c) return;
          guests.delete(cid);
          if (engine) engine.disconnect(cid);
        };
        c.on('close', gone);
        c.on('error', gone);
      });

      // Losing the PeerJS service doesn't drop players already connected; just reconnect to it.
      p.on('disconnected', () => { if (!p.destroyed && peer === p) p.reconnect(); });

      p.on('error', (err) => {
        if (opened) return;
        p.destroy();
        reject(err);
      });
    });
  }

  // ---------- Guest ----------

  function onGuestData(msg) {
    if (!msg) return;
    if (msg.t === 'ack') {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      if (cb) cb(msg.res);
    } else if (msg.t === 'ev') {
      fire(msg.ev, msg.data);
    }
  }

  function openGuest(roomId) {
    return new Promise((resolve, reject) => {
      const p = new Peer(PEER_OPTIONS);
      let done = false;
      const fail = (message) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        p.destroy();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('Could not reach the room. Check the code and try again.'), 20000);

      p.on('open', () => {
        const c = p.connect(PREFIX + roomId, { reliable: true, serialization: 'json' });
        c.on('open', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          peer = p;
          conn = c;
          mode = 'guest';
          resolve();
        });
        c.on('data', onGuestData);
        const dropped = () => { if (conn === c) onGuestDrop(); };
        c.on('close', dropped);
        c.on('error', dropped);
      });

      p.on('error', (err) => {
        if (err.type === 'peer-unavailable') fail('Room not found. Check the code, or the host may have closed the game.');
        else fail('Connection problem. Please check your internet and try again.');
      });
    });
  }

  function request(event, data) {
    return new Promise((resolve) => {
      if (!conn) return resolve({ error: 'Not connected to the room.' });
      const id = ++reqSeq;
      pending.set(id, resolve);
      send(conn, { t: 'req', id, ev: event, data });
    });
  }

  let reconnecting = false;
  async function onGuestDrop() {
    if (reconnecting || !lastJoin) return;
    reconnecting = true;
    const join = lastJoin;
    teardown();
    fire('disconnect');

    for (let attempt = 0; attempt < 10 && join && lastJoin === join; attempt++) {
      await wait(attempt === 0 ? 1500 : 3000);
      if (lastJoin !== join) break;
      try {
        await openGuest(join.roomId);
        const res = await request('joinRoom', join);
        reconnecting = false;
        if (res.error) { lastJoin = null; teardown(); fire('roomGone', res.error); }
        else fire('reconnect');
        return;
      } catch (e) { /* host not back yet; keep trying */ }
    }
    reconnecting = false;
    if (lastJoin === join) {
      lastJoin = null;
      fire('roomGone', 'Lost connection to the host. The game has ended.');
    }
  }

  // ---------- Public API ----------

  async function createRoom({ name, token }) {
    leave();
    for (let i = 0; i < 5; i++) {
      const roomId = makeCode();
      try {
        await openHost(roomId, null);
        return engine.handle('local', 'joinRoom', { roomId, name, token });
      } catch (err) {
        if (err.type !== 'unavailable-id') return { error: 'Could not create a room. Check your internet and try again.' };
      }
    }
    return { error: 'Could not create a room. Please try again.' };
  }

  async function joinRoom({ roomId, name, token }) {
    roomId = String(roomId || '').trim().toUpperCase();
    if (mode === 'host' && engine && engine.room.id === roomId) {
      return engine.handle('local', 'joinRoom', { roomId, name, token });
    }
    leave();

    // The host refreshed the page: bring their game back in this tab.
    let saved = null;
    try { saved = JSON.parse(load(HOST_SAVE_KEY) || 'null'); } catch (e) { saved = null; }
    if (saved && saved.id === roomId) {
      for (let i = 0; i < 8; i++) {
        try {
          await openHost(roomId, saved);
          return engine.handle('local', 'joinRoom', { roomId, name, token });
        } catch (err) {
          if (err.type !== 'unavailable-id') break;
          await wait(2000); // the old page may still hold the room for a moment
        }
      }
      store(HOST_SAVE_KEY, null);
      return { error: 'Could not reopen your room. Please create a new one.' };
    }

    try {
      await openGuest(roomId);
    } catch (e) {
      return { error: e.message };
    }
    const res = await request('joinRoom', { roomId, name, token });
    if (res.error) leave();
    else lastJoin = { roomId, name, token };
    return res;
  }

  function emit(event, data) {
    if (mode === 'host' && engine) return Promise.resolve(engine.handle('local', event, data) || { ok: true });
    if (mode === 'guest' && conn) return request(event, data);
    return Promise.resolve({ error: 'Not connected to a room. Please wait…' });
  }

  function leave() {
    lastJoin = null;
    teardown();
  }

  return {
    on,
    emit,
    createRoom,
    joinRoom,
    leave,
    get isHost() { return mode === 'host'; },
  };
})();
