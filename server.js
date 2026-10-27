'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const TARGET_SCORE = 100;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const CHAT_LIMIT = 50;
const REACTIONS = ['😂', '👏', '🔥', '😡', '😮', '🎉'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

// ---------- Tiles ----------

function newSet() {
  const tiles = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) tiles.push([a, b]);
  }
  return tiles; // 28 tiles
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const isDouble = (t) => t[0] === t[1];
const pipCount = (hand) => hand.reduce((sum, t) => sum + t[0] + t[1], 0);
const sameTile = (t, a, b) => (t[0] === a && t[1] === b) || (t[0] === b && t[1] === a);
const tileText = (t) => `[${t[0]}|${t[1]}]`;

// ---------- Rooms ----------

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 5; i++) id += chars[crypto.randomInt(chars.length)];
  } while (rooms.has(id));
  return id;
}

function createRoom() {
  const room = {
    id: makeRoomId(),
    players: [], // { token, name, socketId, connected, hand, score }
    hostToken: null,
    phase: 'lobby', // lobby | playing | roundover | gameover
    round: 0,
    board: [], // tiles oriented left-to-right
    left: null,
    right: null,
    boneyard: [],
    turn: 0,
    leader: 0,
    passes: 0,
    requiredTile: null,
    nextLeader: null,
    roundResult: null,
    champion: null,
    log: [],
    chat: [], // last CHAT_LIMIT messages: { id, name, seat, text }
    chatSeq: 0,
    lastAction: null, // { seq, type, by, side } so clients can play sounds/animations
    emptySince: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

function setAction(room, type, by, side) {
  const seq = room.lastAction ? room.lastAction.seq + 1 : 1;
  room.lastAction = { seq, type, by, side: side || null };
}

function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 8) room.log.shift();
}

// Which ends of the line a tile can go on ([] if none).
function sidesFor(room, tile) {
  if (room.board.length === 0) {
    if (room.requiredTile && !sameTile(tile, room.requiredTile[0], room.requiredTile[1])) return [];
    return ['right'];
  }
  const sides = [];
  if (tile[0] === room.left || tile[1] === room.left) sides.push('left');
  if (tile[0] === room.right || tile[1] === room.right) sides.push('right');
  return sides;
}

const hasPlay = (room, hand) => hand.some((t) => sidesFor(room, t).length > 0);

function startRound(room) {
  const set = shuffle(newSet());
  const handSize = room.players.length === 2 ? 7 : 5;
  room.players.forEach((p) => { p.hand = set.splice(0, handSize); });
  room.boneyard = set;
  room.board = [];
  room.left = room.right = null;
  room.passes = 0;
  room.roundResult = null;
  room.champion = null;
  room.round += 1;
  room.phase = 'playing';

  if (room.nextLeader === null) {
    // First round: highest double leads; if nobody has a double, the heaviest tile leads.
    let best = null;
    room.players.forEach((p, i) => {
      p.hand.forEach((t) => {
        const rank = isDouble(t) ? 1000 + t[0] : (t[0] + t[1]) * 10 + Math.max(t[0], t[1]);
        if (!best || rank > best.rank) best = { rank, i, t };
      });
    });
    room.turn = best.i;
    room.requiredTile = best.t;
    addLog(room, `Round ${room.round}: ${room.players[best.i].name} opens with ${tileText(best.t)}.`);
  } else {
    // Later rounds: the winner of the previous round leads with any tile.
    room.turn = room.nextLeader;
    room.requiredTile = null;
    addLog(room, `Round ${room.round}: ${room.players[room.turn].name} leads.`);
  }
  room.leader = room.turn;
  setAction(room, 'start', room.turn);
}

function nextTurn(room) {
  room.turn = (room.turn + 1) % room.players.length;
}

function endRound(room, winnerIdx, blocked) {
  const totals = room.players.map((p) => pipCount(p.hand));

  if (blocked) {
    const min = Math.min(...totals);
    const lowest = totals.map((t, i) => (t === min ? i : -1)).filter((i) => i >= 0);
    winnerIdx = lowest.length === 1 ? lowest[0] : null;
  }

  let points = 0;
  if (winnerIdx !== null) {
    points = totals.reduce((sum, t, i) => (i === winnerIdx ? sum : sum + t), 0);
    room.players[winnerIdx].score += points;
  }

  room.roundResult = {
    winner: winnerIdx,
    blocked,
    points,
    hands: room.players.map((p, i) => ({ name: p.name, tiles: p.hand, pips: totals[i] })),
  };
  room.nextLeader = winnerIdx !== null ? winnerIdx : room.leader;

  if (winnerIdx === null) addLog(room, 'The game is blocked and tied. No points.');
  else addLog(room, `${room.players[winnerIdx].name} wins the round${blocked ? ' (blocked game)' : ''} and scores ${points}.`);

  const top = Math.max(...room.players.map((p) => p.score));
  if (top >= TARGET_SCORE) {
    room.phase = 'gameover';
    room.champion = room.players.findIndex((p) => p.score === top);
    addLog(room, `${room.players[room.champion].name} wins the game!`);
  } else {
    room.phase = 'roundover';
  }
}

// What one particular player is allowed to see. Opponents' hands are never sent
// while a round is in progress; only their tile counts.
function viewFor(room, idx) {
  const me = room.players[idx];
  const myTurn = room.phase === 'playing' && room.turn === idx;
  return {
    roomId: room.id,
    phase: room.phase,
    round: room.round,
    target: TARGET_SCORE,
    you: idx,
    host: room.players.findIndex((p) => p.token === room.hostToken),
    players: room.players.map((p) => ({
      name: p.name,
      connected: p.connected,
      tiles: p.hand.length,
      score: p.score,
    })),
    hand: me.hand,
    playable: myTurn ? me.hand.map((t) => sidesFor(room, t)) : me.hand.map(() => []),
    board: room.board,
    left: room.left,
    right: room.right,
    boneyard: room.boneyard.length,
    turn: room.turn,
    requiredTile: room.requiredTile,
    roundResult: room.phase === 'roundover' || room.phase === 'gameover' ? room.roundResult : null,
    champion: room.champion,
    log: room.log,
    lastAction: room.lastAction,
    reactions: REACTIONS,
    chat: room.chat,
  };
}

function broadcast(room) {
  room.players.forEach((p, i) => {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', viewFor(room, i));
  });
}

// ---------- Input helpers ----------

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cleanToken = (t) => (typeof t === 'string' && /^[\w-]{8,64}$/.test(t) ? t : null);
const cleanRoomId = (r) => String(r || '').trim().toUpperCase();

function joinPlayer(socket, room, token, name) {
  let player = room.players.find((p) => p.token === token);
  if (!player) {
    if (!name) return 'Please enter your name.';
    if (room.phase !== 'lobby') return 'This game has already started.';
    if (room.players.length >= MAX_PLAYERS) return 'This room is full (4 players max).';
    player = { token, name, socketId: null, connected: false, hand: [], score: 0 };
    room.players.push(player);
    if (!room.hostToken) room.hostToken = token;
  }
  player.socketId = socket.id;
  player.connected = true;
  room.emptySince = null;
  socket.data.roomId = room.id;
  socket.data.token = token;
  return null;
}

function getCtx(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return null;
  const idx = room.players.findIndex((p) => p.token === socket.data.token);
  if (idx === -1) return null;
  return { room, idx, player: room.players[idx] };
}

// ---------- Socket handlers ----------

io.on('connection', (socket) => {
  const replyFn = (ack) => (typeof ack === 'function' ? ack : () => {});

  socket.on('createRoom', (data, ack) => {
    const reply = replyFn(ack);
    const token = cleanToken(data && data.token);
    const name = cleanName(data && data.name);
    if (!token) return reply({ error: 'Invalid session. Reload the page.' });
    if (!name) return reply({ error: 'Please enter your name.' });
    const room = createRoom();
    joinPlayer(socket, room, token, name);
    reply({ ok: true, roomId: room.id });
    broadcast(room);
  });

  socket.on('joinRoom', (data, ack) => {
    const reply = replyFn(ack);
    const token = cleanToken(data && data.token);
    if (!token) return reply({ error: 'Invalid session. Reload the page.' });
    const room = rooms.get(cleanRoomId(data && data.roomId));
    if (!room) return reply({ error: 'Room not found.' });
    const err = joinPlayer(socket, room, token, cleanName(data && data.name));
    if (err) return reply({ error: err });
    reply({ ok: true, roomId: room.id });
    broadcast(room);
  });

  // All in-room actions go through here: validate, apply, then send everyone their view.
  function onAction(name, handler) {
    socket.on(name, (data, ack) => {
      const reply = replyFn(ack);
      const ctx = getCtx(socket);
      if (!ctx) return reply({ error: 'You are not in a room.' });
      const err = handler(ctx, data || {});
      if (err) return reply({ error: err });
      reply({ ok: true });
      broadcast(ctx.room);
    });
  }

  const isHost = ({ room, player }) => room.hostToken === player.token;

  onAction('startGame', (ctx) => {
    const { room } = ctx;
    if (!isHost(ctx)) return 'Only the host can start the game.';
    if (room.phase !== 'lobby') return 'The game has already started.';
    if (room.players.length < MIN_PLAYERS) return 'You need at least 2 players.';
    room.players.forEach((p) => { p.score = 0; });
    room.round = 0;
    room.nextLeader = null;
    room.log = [];
    startRound(room);
    return null;
  });

  onAction('nextRound', (ctx) => {
    if (!isHost(ctx)) return 'Only the host can start the next round.';
    if (ctx.room.phase !== 'roundover') return 'The round is not over.';
    startRound(ctx.room);
    return null;
  });

  onAction('newGame', (ctx) => {
    const { room } = ctx;
    if (!isHost(ctx)) return 'Only the host can start a new game.';
    if (room.phase !== 'gameover') return 'The game is not over.';
    room.players = room.players.filter((p) => p.connected);
    room.players.forEach((p) => { p.score = 0; p.hand = []; });
    room.phase = 'lobby';
    room.board = [];
    room.boneyard = [];
    room.roundResult = null;
    room.champion = null;
    room.log = [];
    return null;
  });

  onAction('play', ({ room, idx, player }, data) => {
    if (room.phase !== 'playing') return 'No round in progress.';
    if (room.turn !== idx) return 'It is not your turn.';
    const tile = data.tile;
    if (!Array.isArray(tile) || tile.length !== 2) return 'Invalid tile.';
    const handIdx = player.hand.findIndex((t) => sameTile(t, tile[0], tile[1]));
    if (handIdx === -1) return 'You do not have that tile.';
    const t = player.hand[handIdx];
    const sides = sidesFor(room, t);
    if (sides.length === 0) {
      return room.requiredTile ? `You must open with ${tileText(room.requiredTile)}.` : 'That tile does not match either end.';
    }
    const side = room.board.length === 0 ? 'right' : data.side;
    if (!sides.includes(side)) return 'That tile does not fit on that end.';

    if (room.board.length === 0) {
      room.board.push([t[0], t[1]]);
      room.left = t[0];
      room.right = t[1];
    } else if (side === 'left') {
      const placed = t[1] === room.left ? [t[0], t[1]] : [t[1], t[0]];
      room.board.unshift(placed);
      room.left = placed[0];
    } else {
      const placed = t[0] === room.right ? [t[0], t[1]] : [t[1], t[0]];
      room.board.push(placed);
      room.right = placed[1];
    }
    player.hand.splice(handIdx, 1);
    room.requiredTile = null;
    room.passes = 0;
    addLog(room, `${player.name} played ${tileText(t)}.`);
    setAction(room, 'play', idx, side);

    if (player.hand.length === 0) endRound(room, idx, false);
    else nextTurn(room);
    return null;
  });

  onAction('draw', ({ room, idx, player }) => {
    if (room.phase !== 'playing') return 'No round in progress.';
    if (room.turn !== idx) return 'It is not your turn.';
    if (hasPlay(room, player.hand)) return 'You have a playable tile, so you cannot draw.';
    if (room.boneyard.length === 0) return 'The boneyard is empty. You must pass.';
    player.hand.push(room.boneyard.pop());
    addLog(room, `${player.name} drew a tile.`);
    setAction(room, 'draw', idx);
    return null;
  });

  onAction('pass', ({ room, idx, player }) => {
    if (room.phase !== 'playing') return 'No round in progress.';
    if (room.turn !== idx) return 'It is not your turn.';
    if (hasPlay(room, player.hand)) return 'You have a playable tile, so you cannot pass.';
    if (room.boneyard.length > 0) return 'You must draw from the boneyard first.';
    room.passes += 1;
    addLog(room, `${player.name} passed.`);
    setAction(room, 'pass', idx);
    if (room.passes >= room.players.length) endRound(room, null, true);
    else nextTurn(room);
    return null;
  });

  socket.on('chat', (text) => {
    const ctx = getCtx(socket);
    if (!ctx) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return;
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < 400) return; // light rate limit
    socket.data.lastChat = now;
    const { room, idx, player } = ctx;
    room.chatSeq += 1;
    room.chat.push({ id: room.chatSeq, name: player.name, seat: idx, text: clean });
    if (room.chat.length > CHAT_LIMIT) room.chat.shift();
    broadcast(room);
  });

  socket.on('react', (emoji) => {
    const ctx = getCtx(socket);
    if (!ctx || !REACTIONS.includes(emoji)) return;
    const now = Date.now();
    if (now - (socket.data.lastReact || 0) < 800) return; // light rate limit
    socket.data.lastReact = now;
    ctx.room.players.forEach((p) => {
      if (p.connected && p.socketId) io.to(p.socketId).emit('reaction', { by: ctx.idx, emoji });
    });
  });

  socket.on('disconnect', () => {
    const ctx = getCtx(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (player.socketId !== socket.id) return; // already reconnected on a newer socket
    player.connected = false;
    player.socketId = null;

    if (room.phase === 'lobby') {
      // Before the game starts, leaving frees the seat.
      room.players = room.players.filter((p) => p !== player);
      if (room.hostToken === player.token) room.hostToken = room.players.length ? room.players[0].token : null;
    }
    if (room.players.every((p) => !p.connected)) room.emptySince = Date.now();
    broadcast(room);
  });
});

// Remove rooms nobody has been connected to for a while.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) rooms.delete(id);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`abozo and hufa domino running on http://localhost:${PORT}`);
});
