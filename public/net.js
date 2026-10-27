'use strict';

// Networking without a game server. The browser of the player who creates the room runs
// the game (DominoEngine). Messages travel through a free public MQTT broker over secure
// WebSockets, which works on any network, and they are end-to-end encrypted (ECDH + AES-GCM)
// so nobody else, not even the broker, can read a player's tiles.
window.Net = (function () {
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // the first letter of a code picks the broker
  const TOPIC = 'abozo-hufa-domino/v2/';
  const HOST_SAVE_KEY = 'domino-host-room';
  const HOST_AWAY_MS = 60000; // how long guests wait for a host who refreshed or dropped

  const listeners = {};
  let mode = null; // 'host' | 'guest' | null
  let client = null; // MQTT connection
  let base = null; // topic prefix for the current room

  // Host side
  let engine = null;
  let hostKeys = null; // { privateKey, priv (jwk), pub (jwk) }
  let announceTimer = null;
  const peerKeys = new Map(); // guest id -> AES key

  // Guest side
  let guest = null; // { cid, keys, pub, key, hostPub }
  let lastJoin = null; // used to rejoin after a dropped connection
  let awayTimer = null;
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

  function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function makeCode(brokerIndex) {
    const buf = crypto.getRandomValues(new Uint32Array(5));
    const firstChoices = CODE_CHARS.split('').filter((c, i) => i % BROKERS.length === brokerIndex);
    return firstChoices[buf[0] % firstChoices.length] +
      Array.from(buf.slice(1), (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
  }

  const brokerFor = (code) => Math.max(0, CODE_CHARS.indexOf(code[0])) % BROKERS.length;

  // Messages are processed strictly in order, even though encryption is asynchronous.
  let inChain = Promise.resolve();
  let outChain = Promise.resolve();
  const serialIn = (fn) => { inChain = inChain.then(fn).catch(() => {}); };
  const serialOut = (fn) => { outChain = outChain.then(fn).catch(() => {}); };

  // ---------- Encryption ----------

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  const toB64 = (buf) => {
    let s = '';
    new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const text = (payload) => (typeof payload === 'string' ? payload : decoder.decode(payload));

  async function newKeys() {
    const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
    return {
      privateKey: pair.privateKey,
      priv: await crypto.subtle.exportKey('jwk', pair.privateKey),
      pub: await crypto.subtle.exportKey('jwk', pair.publicKey),
    };
  }

  async function importKeys(saved) {
    const privateKey = await crypto.subtle.importKey('jwk', saved.priv, ECDH, true, ['deriveKey']);
    return { privateKey, priv: saved.priv, pub: saved.pub };
  }

  async function sharedKey(privateKey, otherPub) {
    const pub = await crypto.subtle.importKey('jwk', otherPub, ECDH, false, []);
    return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(obj)));
    return { iv: toB64(iv), ct: toB64(ct) };
  }

  async function unseal(key, box) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
    return JSON.parse(decoder.decode(pt));
  }

  // ---------- Broker ----------

  function connectBroker(index, will) {
    return new Promise((resolve, reject) => {
      const c = mqtt.connect(BROKERS[index], {
        clientId: 'ahd_' + randomHex(8),
        clean: true,
        keepalive: 20,
        connectTimeout: 8000,
        reconnectPeriod: 2000,
        will,
      });
      const timer = setTimeout(() => { c.end(true); reject(new Error('timeout')); }, 9000);
      c.once('connect', () => { clearTimeout(timer); resolve(c); });
      c.on('error', () => { /* mqtt.js retries by itself */ });
    });
  }

  // Resolves with the room's retained host announcement, or null if there is none.
  function lookupHost(c, roomBase, ms) {
    return new Promise((resolve) => {
      const topic = roomBase + '/host';
      const onMessage = (t, payload) => {
        if (t !== topic) return;
        const body = text(payload);
        if (!body) return;
        done(JSON.parse(body));
      };
      const done = (result) => {
        clearTimeout(timer);
        c.removeListener('message', onMessage);
        resolve(result);
      };
      const timer = setTimeout(() => done(null), ms);
      c.on('message', onMessage);
      c.subscribe(topic);
    });
  }

  function teardown() {
    clearInterval(announceTimer);
    clearTimeout(awayTimer);
    announceTimer = awayTimer = null;
    if (client) {
      try { client.end(true); } catch (e) { /* ignore */ }
    }
    client = null;
    base = null;
    mode = null;
    engine = null;
    hostKeys = null;
    guest = null;
    peerKeys.clear();
    pending.clear();
  }

  // ---------- Host ----------

  function sendTo(cid, obj) {
    const c = client;
    const topic = base + '/down/' + cid;
    serialOut(async () => {
      const key = peerKeys.get(cid);
      if (!key || !c || c !== client) return;
      c.publish(topic, JSON.stringify(await seal(key, obj)));
    });
  }

  function deliver(cid, event, data) {
    if (cid === 'local') {
      // Copy, so the host's screen gets a snapshot like guests do (not live engine arrays).
      // A microtask rather than setTimeout: timers are heavily throttled in background tabs.
      const snapshot = JSON.parse(JSON.stringify(data));
      Promise.resolve().then(() => fire(event, snapshot));
      return;
    }
    sendTo(cid, { t: 'ev', ev: event, data });
  }

  async function onHostMessage(payload) {
    let msg;
    try { msg = JSON.parse(text(payload)); } catch (e) { return; }
    if (!msg || typeof msg.cid !== 'string' || !engine) return;

    if (msg.t === 'hello') {
      peerKeys.set(msg.cid, await sharedKey(hostKeys.privateKey, msg.pub));
      return;
    }
    if (msg.t === 'bye') {
      peerKeys.delete(msg.cid);
      engine.disconnect(msg.cid);
      return;
    }
    const key = peerKeys.get(msg.cid);
    if (!key) return;
    let req;
    try { req = await unseal(key, msg); } catch (e) { return; }
    if (!req || req.t !== 'req' || !engine) return;
    const res = engine.handle(msg.cid, req.ev, req.data);
    if (req.id) sendTo(msg.cid, { t: 'ack', id: req.id, res: res || { ok: true } });
  }

  async function openHost(code, savedRoom, savedKeys, c) {
    base = TOPIC + code;
    hostKeys = savedKeys ? await importKeys(savedKeys) : await newKeys();
    client = c;
    mode = 'host';
    const roomBase = base;
    const keysToSave = { priv: hostKeys.priv, pub: hostKeys.pub };
    engine = DominoEngine.create(code, savedRoom, deliver, (room) => {
      store(HOST_SAVE_KEY, JSON.stringify({ room, keys: keysToSave }));
    });

    const announce = () => {
      if (client === c) c.publish(roomBase + '/host', JSON.stringify({ pub: hostKeys.pub }), { retain: true, qos: 1 });
    };
    c.on('message', (topic, payload) => {
      if (topic === roomBase + '/up') serialIn(() => onHostMessage(payload));
    });
    c.on('connect', () => { c.subscribe(roomBase + '/up'); announce(); }); // after an automatic reconnect
    c.subscribe(roomBase + '/up');
    announce();
    announceTimer = setInterval(announce, 30000);
  }

  // The broker clears the room announcement if the host's connection dies.
  const hostWill = (code) => ({ topic: TOPIC + code + '/host', payload: '', retain: true, qos: 1 });

  // ---------- Guest ----------

  function request(event, data, timeoutMs) {
    return new Promise((resolve) => {
      if (!guest || !client) return resolve({ error: 'Not connected to the room. Please wait…' });
      const id = ++reqSeq;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: 'The room did not answer. The host may have left. Please try again.' });
      }, timeoutMs || 10000);
      pending.set(id, (res) => { clearTimeout(timer); resolve(res); });
      const c = client;
      const g = guest;
      serialOut(async () => {
        if (c !== client) return;
        c.publish(base + '/up', JSON.stringify(Object.assign({ cid: g.cid }, await seal(g.key, { t: 'req', id, ev: event, data }))));
      });
    });
  }

  function sayHello() {
    if (!guest || !client) return;
    client.publish(base + '/up', JSON.stringify({ cid: guest.cid, t: 'hello', pub: guest.pub }));
  }

  async function rejoin() {
    if (!lastJoin) return;
    sayHello();
    const res = await request('joinRoom', lastJoin);
    if (res.error) {
      if (/not answer/.test(res.error)) return; // keep waiting for the host
      lastJoin = null;
      teardown();
      fire('roomGone', res.error);
    } else {
      fire('reconnect');
    }
  }

  function hostAway() {
    if (awayTimer) return;
    fire('disconnect');
    awayTimer = setTimeout(() => {
      awayTimer = null;
      if (!lastJoin) return;
      lastJoin = null;
      teardown();
      fire('roomGone', 'The host left. The game has ended.');
    }, HOST_AWAY_MS);
  }

  async function onGuestMessage(topic, payload) {
    if (!guest) return;
    if (topic === base + '/host') {
      const body = text(payload);
      if (!body) return hostAway();
      if (awayTimer) {
        // The host is back (for example after refreshing the page).
        clearTimeout(awayTimer);
        awayTimer = null;
        const ann = JSON.parse(body);
        guest.key = await sharedKey(guest.keys.privateKey, ann.pub);
        rejoin();
      }
      return;
    }
    let msg;
    try { msg = await unseal(guest.key, JSON.parse(text(payload))); } catch (e) { return; }
    if (msg.t === 'ack') {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      if (cb) cb(msg.res);
    } else if (msg.t === 'ev') {
      fire(msg.ev, msg.data);
    }
  }

  async function openGuest(code) {
    const roomBase = TOPIC + code;
    const cid = randomHex(16);
    const keys = await newKeys();
    let c;
    try {
      c = await connectBroker(brokerFor(code), { topic: roomBase + '/up', payload: JSON.stringify({ cid, t: 'bye' }), qos: 0, retain: false });
    } catch (e) {
      throw new Error('Could not connect. Please check your internet and try again.');
    }
    const ann = await lookupHost(c, roomBase, 7000);
    if (!ann) {
      c.end(true);
      throw new Error('Room not found. Check the code, or the host may have closed the game.');
    }
    base = roomBase;
    client = c;
    mode = 'guest';
    guest = { cid, keys, pub: keys.pub, key: await sharedKey(keys.privateKey, ann.pub) };

    c.on('message', (topic, payload) => serialIn(() => onGuestMessage(topic, payload)));
    c.subscribe(roomBase + '/down/' + cid);
    let dropped = false;
    c.on('offline', () => { if (client === c && !dropped) { dropped = true; fire('disconnect'); } });
    c.on('connect', () => {
      // Automatic reconnect after a network blip: subscribe again and rejoin our seat.
      if (client !== c) return;
      c.subscribe([roomBase + '/host', roomBase + '/down/' + cid]);
      if (dropped) { dropped = false; rejoin(); }
    });
    sayHello();
  }

  // ---------- Public API ----------

  async function createRoom({ name, token }) {
    leave();
    for (let b = 0; b < BROKERS.length; b++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = makeCode(b);
        let c;
        try { c = await connectBroker(b, hostWill(code)); } catch (e) { break; } // try the next broker
        // Make sure nobody is already using this code.
        if (await lookupHost(c, TOPIC + code, 1200)) { c.end(true); continue; }
        await openHost(code, null, null, c);
        return engine.handle('local', 'joinRoom', { roomId: code, name, token });
      }
    }
    return { error: 'Could not create a room. Please check your internet and try again.' };
  }

  async function joinRoom({ roomId, name, token }) {
    const code = String(roomId || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return { error: 'Room codes have 5 letters and numbers.' };
    if (mode === 'host' && engine && engine.room.id === code) {
      return engine.handle('local', 'joinRoom', { roomId: code, name, token });
    }
    leave();

    // The host refreshed the page: bring their game back in this tab.
    let saved = null;
    try { saved = JSON.parse(load(HOST_SAVE_KEY) || 'null'); } catch (e) { saved = null; }
    if (saved && saved.room && saved.room.id === code) {
      try {
        const c = await connectBroker(brokerFor(code), hostWill(code));
        await openHost(code, saved.room, saved.keys, c);
        return engine.handle('local', 'joinRoom', { roomId: code, name, token });
      } catch (e) {
        return { error: 'Could not reconnect. Please check your internet and refresh.' };
      }
    }

    try {
      await openGuest(code);
    } catch (e) {
      return { error: e.message };
    }
    const res = await request('joinRoom', { roomId: code, name, token });
    if (res.error) leave();
    else lastJoin = { roomId: code, name, token };
    return res;
  }

  function emit(event, data) {
    if (mode === 'host' && engine) return Promise.resolve(engine.handle('local', event, data) || { ok: true });
    if (mode === 'guest') return request(event, data);
    return Promise.resolve({ error: 'Not connected to a room. Please wait…' });
  }

  function leave() {
    if (client && base) {
      // Say goodbye explicitly: a clean disconnect doesn't trigger the broker's last-will message.
      try {
        if (mode === 'host') client.publish(base + '/host', '', { retain: true, qos: 1 });
        if (mode === 'guest' && guest) client.publish(base + '/up', JSON.stringify({ cid: guest.cid, t: 'bye' }));
      } catch (e) { /* ignore */ }
    }
    lastJoin = null;
    const c = client;
    client = null; // so teardown doesn't end it before the goodbye is sent
    teardown();
    if (c) setTimeout(() => { try { c.end(); } catch (e) { /* ignore */ } }, 300);
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
