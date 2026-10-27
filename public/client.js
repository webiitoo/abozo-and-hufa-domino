'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // Pip positions in a 3x3 grid (cells 0-8) for each value.
  const PIP_LAYOUT = {
    0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8],
    4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
  };
  const SEAT_COLORS = ['#ef5350', '#3d7bff', '#2eaa5c', '#f59f00'];

  // ---------- Session (per browser tab, survives a page refresh) ----------

  function load(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function store(key, value) {
    try {
      if (value == null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch (e) { /* storage unavailable: refresh will just lose the seat */ }
  }
  function makeToken() {
    if (window.crypto && crypto.randomUUID) {
      try { return crypto.randomUUID(); } catch (e) { /* not a secure context */ }
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  const token = load('domino-token') || makeToken();
  store('domino-token', token);
  let roomId = load('domino-room');
  let myName = load('domino-name') || '';
  let state = null;
  let pendingTile = null; // tile waiting for the player to pick an end

  // Highest action numbers we have already animated, so a re-render doesn't replay them.
  let animatedSeq = 0;

  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (urlRoom) {
    $('join-code').value = urlRoom;
    if (roomId && roomId !== urlRoom) roomId = null;
  }
  $('name').value = myName;

  // ---------- Small UI helpers ----------

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  function showError(msg) {
    Sound.play('error');
    toast(msg, 'error');
  }

  function show(screen) {
    ['home', 'lobby', 'game'].forEach((s) => { $(s).hidden = s !== screen; });
  }

  function enterRoom(id) {
    roomId = id;
    store('domino-room', id);
    history.replaceState(null, '', '?room=' + id);
  }

  function leaveToHome(msg) {
    roomId = null;
    state = null;
    store('domino-room', null);
    Net.leave();
    $('result').hidden = true;
    $('chat-btn').hidden = true;
    $('chat-panel').hidden = true;
    show('home');
    if (msg) showError(msg);
  }

  function readName() {
    const n = $('name').value.trim();
    if (!n) { showError('Please enter your name first.'); $('name').focus(); return null; }
    myName = n;
    store('domino-name', n);
    return n;
  }

  function action(name, data) {
    Net.emit(name, data || {}).then((res) => {
      if (res && res.error) showError(res.error);
    });
  }

  const tileText = (t) => `[${t[0]}|${t[1]}]`;

  function avatarEl(name, seat) {
    const a = document.createElement('div');
    a.className = 'avatar';
    a.style.background = SEAT_COLORS[seat % SEAT_COLORS.length];
    a.textContent = (name || '?').charAt(0).toUpperCase();
    return a;
  }

  function halfEl(value) {
    const half = document.createElement('div');
    half.className = 'half v' + value;
    for (let i = 0; i < 9; i++) {
      const pip = document.createElement('span');
      pip.className = PIP_LAYOUT[value].includes(i) ? 'pip on' : 'pip';
      half.appendChild(pip);
    }
    return half;
  }

  function tileEl(t, vertical, extraClass) {
    const el = document.createElement('div');
    el.className = 'tile' + (vertical ? ' vertical' : '') + (extraClass ? ' ' + extraClass : '');
    el.title = tileText(t);
    el.appendChild(halfEl(t[0]));
    el.appendChild(halfEl(t[1]));
    return el;
  }

  // Decorative tiles on the home screen
  $('logo-tiles').appendChild(tileEl([6, 6], true));
  $('logo-tiles').appendChild(tileEl([5, 3], true));

  // ---------- Sound toggle ----------

  function updateSoundBtn() { $('sound-btn').textContent = Sound.muted ? '🔇' : '🔊'; }
  $('sound-btn').onclick = () => { Sound.toggle(); updateSoundBtn(); Sound.play('click'); };
  updateSoundBtn();

  // ---------- Home ----------

  function setBusy(busy, text) {
    $('create-btn').disabled = busy;
    $('join-btn').disabled = busy;
    $('home-busy').hidden = !busy;
    $('home-busy').textContent = text || '';
  }

  $('create-btn').onclick = () => {
    const name = readName();
    if (!name) return;
    Sound.play('click');
    setBusy(true, 'Creating your room…');
    Net.createRoom({ name, token }).then((res) => {
      setBusy(false);
      if (res.error) return showError(res.error);
      enterRoom(res.roomId);
    });
  };

  $('join-btn').onclick = () => {
    const name = readName();
    if (!name) return;
    const code = $('join-code').value.trim().toUpperCase();
    if (!code) return showError('Please enter a room code.');
    Sound.play('click');
    setBusy(true, 'Connecting to the room…');
    Net.joinRoom({ roomId: code, name, token }).then((res) => {
      setBusy(false);
      if (res.error) return showError(res.error);
      enterRoom(res.roomId);
    });
  };

  $('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('join-code').value.trim() ? $('join-btn') : $('create-btn')).click();
  });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });

  // ---------- Lobby ----------

  $('copy-btn').onclick = () => {
    const input = $('share-link');
    input.select();
    const done = () => { Sound.play('pop'); toast('Link copied! Send it to your friends 🎉'); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(input.value).then(done, done);
    else { document.execCommand('copy'); done(); }
  };

  $('start-btn').onclick = () => { Sound.play('click'); action('startGame'); };

  function renderLobby() {
    $('room-code').textContent = state.roomId;
    $('share-link').value = location.origin + location.pathname + '?room=' + state.roomId;
    $('player-count').textContent = `${state.players.length} / 4`;

    const list = $('lobby-players');
    list.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const p = state.players[i];
      const seat = document.createElement('div');
      if (p) {
        seat.className = 'lobby-seat';
        seat.appendChild(avatarEl(p.name, i));
        const info = document.createElement('div');
        info.textContent = p.name + (i === state.you ? ' (you)' : '');
        const sub = document.createElement('small');
        sub.textContent = i === state.host ? '👑 Host' : 'Ready';
        info.appendChild(sub);
        seat.appendChild(info);
      } else {
        seat.className = 'lobby-seat empty';
        const a = document.createElement('div');
        a.className = 'avatar empty';
        a.textContent = '?';
        seat.appendChild(a);
        seat.appendChild(document.createTextNode('Waiting…'));
      }
      list.appendChild(seat);
    }

    const amHost = state.you === state.host;
    $('start-btn').hidden = !amHost;
    $('start-btn').disabled = state.players.length < 2;
    $('lobby-wait').textContent = amHost
      ? (state.players.length < 2 ? 'You need at least one friend to start.' : 'Everyone in? Press start!') +
        ' Keep this tab open: the game runs on your device.'
      : 'Waiting for the host to start the game…';
  }

  // ---------- Game ----------

  $('draw-btn').onclick = () => action('draw');
  $('pass-btn').onclick = () => action('pass');

  // Reaction buttons are built once the server tells us the list.
  let reactionsBuilt = false;
  function buildReactions(list) {
    if (reactionsBuilt) return;
    reactionsBuilt = true;
    list.forEach((emoji) => {
      const b = document.createElement('button');
      b.textContent = emoji;
      b.title = 'Send ' + emoji;
      b.onclick = () => Net.emit('react', emoji);
      $('reactions').appendChild(b);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingTile) { pendingTile = null; render(); }
  });

  function play(tile, side) {
    pendingTile = null;
    action('play', { tile, side });
  }

  function onTileClick(i) {
    if (state.phase !== 'playing' || state.turn !== state.you) return;
    const tile = state.hand[i];
    const sides = state.playable[i];
    if (!sides.length) return showError('That tile does not match either end.');
    if (sides.length === 1 || state.left === state.right) return play(tile, sides[0]);
    // Fits both ends: let the player pick by clicking a glowing end on the table.
    const same = pendingTile && pendingTile[0] === tile[0] && pendingTile[1] === tile[1];
    pendingTile = same ? null : tile;
    Sound.play('click');
    render();
  }

  function endSlot(side) {
    const el = document.createElement('div');
    el.className = 'end-slot';
    el.textContent = side === 'left' ? `◀ ${state.left}` : `${state.right} ▶`;
    el.title = `Play on the ${side} end`;
    el.onclick = () => play(pendingTile, side);
    return el;
  }

  function renderBoard() {
    const board = $('board');
    board.innerHTML = '';
    board.classList.toggle('crowded', state.board.length > 12 && state.board.length <= 20);
    board.classList.toggle('packed', state.board.length > 20);

    if (!state.board.length) {
      const empty = document.createElement('div');
      empty.className = 'board-empty';
      empty.textContent = state.phase === 'playing' ? 'Waiting for the first tile…' : '';
      board.appendChild(empty);
      return;
    }

    const a = state.lastAction;
    const animate = a && a.type === 'play' && a.seq > animatedSeq;
    if (pendingTile) board.appendChild(endSlot('left'));
    state.board.forEach((t, i) => {
      const isNew = animate && ((a.side === 'left' && i === 0) || (a.side !== 'left' && i === state.board.length - 1));
      board.appendChild(tileEl(t, t[0] === t[1], isNew ? 'placed' : ''));
    });
    if (pendingTile) board.appendChild(endSlot('right'));
  }

  function renderSeats() {
    const me = state.you;
    const n = state.players.length;
    const opp = $('opponents');
    opp.innerHTML = '';
    // Show opponents in turn order, starting with the player after me.
    for (let k = 1; k < n; k++) {
      const i = (me + k) % n;
      const p = state.players[i];
      const seat = document.createElement('div');
      const active = state.phase === 'playing' && state.turn === i;
      seat.className = 'seat' + (active ? ' active' : '') + (p.connected ? '' : ' offline');
      seat.dataset.seat = i;
      seat.appendChild(avatarEl(p.name, i));

      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'seat-name';
      name.textContent = p.name;
      const sub = document.createElement('div');
      sub.className = 'seat-sub';
      if (!p.connected) sub.textContent = `${p.score} pts · offline`;
      else if (active) sub.innerHTML = `${p.score} pts · <span class="thinking">playing…</span>`;
      else sub.textContent = `${p.score} pts`;
      const backs = document.createElement('div');
      backs.className = 'backs';
      for (let t = 0; t < p.tiles; t++) {
        const b = document.createElement('span');
        b.className = 'back';
        backs.appendChild(b);
      }
      info.append(name, sub, backs);
      seat.appendChild(info);
      opp.appendChild(seat);
    }

    const meSeat = $('me-seat');
    meSeat.innerHTML = '';
    meSeat.dataset.seat = me;
    meSeat.appendChild(avatarEl(state.players[me].name, me));
    const label = document.createElement('div');
    label.textContent = `${state.players[me].name} (you) · ${state.players[me].score} pts`;
    meSeat.appendChild(label);
  }

  function renderGame() {
    const me = state.you;
    const myTurn = state.phase === 'playing' && state.turn === me;
    const canPlay = state.playable.some((s) => s.length > 0);

    $('round-info').innerHTML = '';
    [`Room ${state.roomId}`, `Round ${state.round}`, `🏆 First to ${state.target}`].forEach((txt) => {
      const s = document.createElement('span');
      s.textContent = txt;
      $('round-info').appendChild(s);
    });
    $('boneyard-count').textContent = state.boneyard;

    renderSeats();
    buildReactions(state.reactions || []);

    if (!myTurn) pendingTile = null;
    if (pendingTile && !state.hand.some((t) => t[0] === pendingTile[0] && t[1] === pendingTile[1])) pendingTile = null;
    renderBoard();

    let status = '';
    if (state.phase === 'playing') {
      if (!myTurn) status = `⏳ ${state.players[state.turn].name} is thinking…`;
      else if (pendingTile) status = '👆 Tap the glowing end where you want to place it';
      else if (state.requiredTile && !state.board.length) status = `⭐ Your turn! Open with ${tileText(state.requiredTile)}`;
      else if (canPlay) status = '⭐ Your turn! Pick a tile';
      else if (state.boneyard > 0) status = '😬 No match. Draw from the boneyard!';
      else status = '🙈 No match and the boneyard is empty. Pass!';
    } else {
      status = 'Round over!';
    }
    const st = $('status');
    st.textContent = status;
    st.className = 'status' + (myTurn ? ' mine' : '');

    $('draw-btn').hidden = !(myTurn && !canPlay && state.boneyard > 0);
    $('pass-btn').hidden = !(myTurn && !canPlay && state.boneyard === 0);

    const a = state.lastAction;
    const fresh = a && a.seq > animatedSeq;
    const hand = $('hand');
    hand.innerHTML = '';
    hand.classList.toggle('my-turn', myTurn);
    state.hand.forEach((t, i) => {
      let cls = '';
      if (fresh && a.type === 'start') cls = 'new';
      if (fresh && a.type === 'draw' && a.by === me && i === state.hand.length - 1) cls = 'new';
      const el = tileEl(t, true, cls);
      if (cls && a.type === 'start') el.style.animationDelay = (i * 0.07) + 's';
      if (myTurn && state.playable[i].length) el.classList.add('playable');
      if (pendingTile && pendingTile[0] === t[0] && pendingTile[1] === t[1]) el.classList.add('selected');
      el.onclick = () => onTileClick(i);
      hand.appendChild(el);
    });

    const log = $('log');
    log.innerHTML = '';
    state.log.slice().reverse().forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      log.appendChild(li);
    });

    if (fresh) animatedSeq = a.seq;
    renderResult();
  }

  function renderResult() {
    const r = state.roundResult;
    $('result').hidden = !r;
    if (!r) return;

    const over = state.phase === 'gameover';
    const iWon = over ? state.champion === state.you : r.winner === state.you;

    if (over) {
      $('result-emoji').textContent = iWon ? '🏆' : '👏';
      $('result-title').textContent = iWon ? 'You won the game!' : `${state.players[state.champion].name} wins the game!`;
    } else if (r.winner === null) {
      $('result-emoji').textContent = '🤝';
      $('result-title').textContent = 'It\'s a tie!';
    } else {
      $('result-emoji').textContent = iWon ? '🎉' : '😅';
      $('result-title').textContent = iWon ? 'You won the round!' : `${state.players[r.winner].name} won the round`;
    }

    if (r.winner === null) {
      $('result-text').textContent = 'The game is blocked and tied. No points this round.';
    } else {
      const name = r.winner === state.you ? 'You' : state.players[r.winner].name;
      $('result-text').textContent = r.blocked
        ? `Blocked game! ${name} had the fewest pips: +${r.points} points.`
        : `Domino! ${name} played every tile: +${r.points} points.`;
    }

    const list = $('result-hands');
    list.innerHTML = '';
    r.hands.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'result-row' + (i === r.winner ? ' winner' : '');
      row.appendChild(avatarEl(h.name, i));

      const info = document.createElement('div');
      info.className = 'info';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = h.name + (i === state.you ? ' (you)' : '') + (i === r.winner ? ' 👑' : '');
      const tiles = document.createElement('div');
      tiles.className = 'mini-tiles';
      h.tiles.forEach((t) => tiles.appendChild(tileEl(t, false, 'mini')));
      if (!h.tiles.length) tiles.textContent = 'No tiles left!';
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = Math.min(100, (state.players[i].score / state.target) * 100) + '%';
      bar.appendChild(fill);
      info.append(name, tiles, bar);

      const score = document.createElement('div');
      score.className = 'score';
      score.textContent = state.players[i].score;
      const small = document.createElement('small');
      small.textContent = `${h.pips} pips left`;
      score.appendChild(small);

      row.append(info, score);
      list.appendChild(row);
    });

    const amHost = state.you === state.host;
    const btn = $('result-btn');
    btn.hidden = !amHost;
    btn.textContent = over ? '🔁 Play again' : '▶ Next round';
    btn.onclick = () => { Sound.play('click'); action(over ? 'newGame' : 'nextRound'); };
    $('result-wait').textContent = amHost ? '' : 'Waiting for the host to continue…';
  }

  function render() {
    if (!state) return;
    if (state.phase === 'lobby') {
      $('result').hidden = true;
      renderLobby();
      show('lobby');
    } else {
      renderGame();
      show('game');
    }
  }

  // ---------- Chat ----------

  let chatOpen = false;
  let chatShownId = 0; // newest message already added to the list
  let unread = 0;

  function setChatOpen(open) {
    chatOpen = open;
    $('chat-panel').hidden = !open;
    if (open) {
      unread = 0;
      $('chat-badge').hidden = true;
      $('chat-list').scrollTop = $('chat-list').scrollHeight;
      $('chat-input').focus();
    }
  }

  $('chat-btn').onclick = () => { Sound.play('click'); setChatOpen(!chatOpen); };
  $('chat-close').onclick = () => setChatOpen(false);
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    Net.emit('chat', text);
    $('chat-input').value = '';
  };

  function renderChat(isNewRoom) {
    const list = $('chat-list');
    const msgs = state.chat || [];
    if (isNewRoom) {
      list.innerHTML = '';
      chatShownId = 0;
      unread = 0;
      $('chat-badge').hidden = true;
    }
    if (!msgs.length && !list.children.length) {
      const empty = document.createElement('li');
      empty.className = 'chat-empty';
      empty.textContent = 'No messages yet. Say hi! 👋';
      list.appendChild(empty);
    }

    const fresh = msgs.filter((m) => m.id > chatShownId);
    if (!fresh.length) return;
    const emptyEl = list.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    fresh.forEach((m) => {
      const mine = m.name === state.players[state.you].name && m.seat === state.you;
      const li = document.createElement('li');
      li.className = 'chat-msg' + (mine ? ' mine' : '');
      li.appendChild(avatarEl(m.name, m.seat));
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (!mine) {
        const who = document.createElement('small');
        who.textContent = m.name;
        bubble.appendChild(who);
      }
      bubble.appendChild(document.createTextNode(m.text));
      li.appendChild(bubble);
      list.appendChild(li);

      // Only alert for messages that arrived live, not the history loaded on join.
      if (!mine && !isNewRoom) {
        Sound.play('message');
        if (!chatOpen) {
          unread += 1;
          toast(`💬 ${m.name}: ${m.text.length > 60 ? m.text.slice(0, 60) + '…' : m.text}`);
        }
      }
    });
    while (list.children.length > 50) list.firstChild.remove();
    chatShownId = fresh[fresh.length - 1].id;
    if (atBottom || chatOpen) list.scrollTop = list.scrollHeight;

    $('chat-badge').hidden = unread === 0;
    $('chat-badge').textContent = unread > 9 ? '9+' : unread;
    if (unread && !isNewRoom) {
      $('chat-btn').classList.remove('bump');
      void $('chat-btn').offsetWidth; // restart the animation
      $('chat-btn').classList.add('bump');
    }
  }

  // ---------- Effects driven by state changes ----------

  function playEffects(prev, next) {
    if (!prev || prev.roomId !== next.roomId) return;
    const a = next.lastAction;
    const isNewAction = a && (!prev.lastAction || a.seq !== prev.lastAction.seq);

    if (next.phase === 'lobby' && next.players.length > prev.players.length) {
      Sound.play('join');
      toast(`${next.players[next.players.length - 1].name} joined the room 👋`);
    }
    if (next.phase === 'lobby' && next.players.length < prev.players.length) toast('A player left the room');

    if (isNewAction) {
      if (a.type === 'play') Sound.play('clack');
      else if (a.type === 'draw') Sound.play('draw');
      else if (a.type === 'start') Sound.play('shuffle');
      else if (a.type === 'pass') {
        Sound.play('pass');
        toast(a.by === next.you ? 'You passed' : `${next.players[a.by].name} passed 🙈`);
      }
    }

    const nowMine = next.phase === 'playing' && next.turn === next.you;
    const wasMine = prev.phase === 'playing' && prev.turn === prev.you;
    if (nowMine && !wasMine) setTimeout(() => Sound.play('turn'), 300);

    if (next.roundResult && !prev.roundResult) {
      const over = next.phase === 'gameover';
      const iWon = over ? next.champion === next.you : next.roundResult.winner === next.you;
      setTimeout(() => {
        if (iWon) { Sound.play('win'); confetti(over ? 320 : 160); }
        else if (next.roundResult.winner === null) Sound.play('pass');
        else Sound.play('lose');
      }, 350);
    }

    prev.players.forEach((p, i) => {
      const q = next.players[i];
      if (q && p.connected && !q.connected && next.phase !== 'lobby') toast(`${q.name} lost connection`);
      if (q && !p.connected && q.connected && next.phase !== 'lobby') toast(`${q.name} is back 👍`);
    });
  }

  // Emoji reactions float up from the sender's seat.
  Net.on('reaction', ({ by, emoji }) => {
    if (!state) return;
    Sound.play('pop');
    const anchor = document.querySelector(`[data-seat="${by}"]`);
    const rect = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 20, top: innerHeight / 2, width: 40 };
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;
    const who = document.createElement('small');
    who.textContent = state.players[by] ? state.players[by].name : '';
    el.appendChild(who);
    el.style.left = (rect.left + rect.width / 2 - 30 + (Math.random() * 40 - 20)) + 'px';
    el.style.top = (rect.top - 20) + 'px';
    $('float-layer').appendChild(el);
    setTimeout(() => el.remove(), 2300);
  });

  // ---------- Confetti ----------

  function confetti(count) {
    const canvas = $('confetti');
    const c = canvas.getContext('2d');
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const colors = ['#ffc23d', '#3d7bff', '#ef5350', '#2eaa5c', '#ffffff', '#8e24aa'];
    const parts = Array.from({ length: count }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 200,
      y: innerHeight * 0.45,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 16 - 6,
      size: Math.random() * 8 + 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const start = performance.now();
    (function frame(now) {
      const t = now - start;
      c.clearRect(0, 0, canvas.width, canvas.height);
      parts.forEach((p) => {
        p.vy += 0.35;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot);
        c.globalAlpha = Math.max(0, 1 - t / 3200);
        c.fillStyle = p.color;
        c.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        c.restore();
      });
      if (t < 3200) requestAnimationFrame(frame);
      else c.clearRect(0, 0, canvas.width, canvas.height);
    })(start);
  }

  // ---------- Network ----------

  Net.on('disconnect', () => { if (state) toast('Connection lost, reconnecting…', 'error'); });
  Net.on('reconnect', () => toast('Reconnected 👍'));
  Net.on('roomGone', (msg) => leaveToHome(msg));

  // The game runs in the host's browser, so closing that tab ends it for everyone.
  window.addEventListener('beforeunload', (e) => {
    if (Net.isHost && state && state.players.length > 1) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Rejoin our seat after a page refresh.
  if (roomId && myName) {
    setBusy(true, 'Reconnecting to your room…');
    Net.joinRoom({ roomId, name: myName, token }).then((res) => {
      setBusy(false);
      if (res.error) leaveToHome(res.error);
    });
  }

  Net.on('state', (s) => {
    const prev = state;
    const newRoom = !prev || prev.roomId !== s.roomId;
    if (newRoom) animatedSeq = 0;
    state = s;
    playEffects(prev, s);
    render();
    $('chat-btn').hidden = false;
    renderChat(newRoom);
  });
})();
