// Milkky game server. WebSocket on /ws, health check on /health.
// Meant to sit behind nginx: listens on 127.0.0.1 unless HOST says otherwise.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import RAPIER_MOD from '@dimforge/rapier3d-compat';
import { Room, hashKey } from './room.js';
import * as store from './store.js';

const RAPIER = RAPIER_MOD.default || RAPIER_MOD;
await RAPIER.init();

const PORT = +process.env.PORT || 8080, HOST = process.env.HOST || '127.0.0.1';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const MAX_ROOMS = 500;
const EMPTY_ROOM_TTL = 2 * 60 * 1000;            // live: close a room this long after the last person leaves
const ASYNC_IDLE_TTL = 14 * 24 * 3600 * 1000;    // async: close a finished (or never started) room after two quiet weeks

const rooms = new Map();
function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
    if (!rooms.has(code)) return code;
  }
}
const findRoom = code => rooms.get(String(code ?? '').toUpperCase().trim());

// Pick up where we left off before the last restart or deploy
for (const d of store.loadAll()) {
  try { rooms.set(d.code, Room.restore(d, RAPIER)); }
  catch (err) { console.error('could not restore room', d.code, err); }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`ok ${rooms.size} rooms\n`); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: true });

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
function enter(ws, room, seat) {
  ws.room = room; ws.seat = seat;
  send(ws, { t: 'joined', code: room.code, token: seat.token, you: room.seatIndex(seat) });
  room.broadcastRoom();
  room.resync(seat);
}

// Give up a seat held elsewhere (`prev` = { code, token }), e.g. when someone follows a link to another room.
function abandon(prev, ws) {
  const room = prev && findRoom(prev.code), seat = room && room.seats.find(s => s.token && s.token === prev.token);
  if (!seat || room.async) return; // async seats are kept: people can be in several of those at once
  if (seat.ws && seat.ws !== ws) { seat.ws.room = seat.ws.seat = null; seat.ws.close(4001, 'Joined another room'); }
  room.disconnect(seat, { left: true });
}

function onMessage(ws, m) {
  // Your games across all rooms, for the "My games" screen
  if (m.t === 'mine') {
    const me = hashKey(m.me);
    const games = me ? [...rooms.values()].map(r => r.summaryFor(me)).filter(Boolean) : [];
    return send(ws, { t: 'mine', games });
  }
  if (ws.room) {
    const { room, seat } = ws;
    // leave: give up the seat (the computer plays it from now on). detach: just step away (async), keeping it.
    if (m.t === 'leave' || m.t === 'detach') { ws.room = ws.seat = null; return room.disconnect(seat, { left: m.t === 'leave' }); }
    return room.handle(seat, m);
  }
  switch (m.t) {
    case 'create': {
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'The server is full, try again later' });
      const room = new Room(newCode(), RAPIER);
      rooms.set(room.code, room);
      enter(ws, room, room.addHuman(ws, m.name, m.me));
      return abandon(m.leave, ws);
    }
    case 'join': {
      const room = findRoom(m.code);
      if (!room) return send(ws, { t: 'error', msg: 'No room with that code' });
      const mine = room.findSeat(null, m.me); // already in this room (e.g. followed its link again): back to that seat
      if (mine) { room.reattach(mine, ws); return enter(ws, room, mine); }
      if (!room.canJoin()) return send(ws, { t: 'error', msg: room.phase === 'playing' ? 'That game has already started' : 'That room is full' });
      enter(ws, room, room.addHuman(ws, m.name, m.me));
      return abandon(m.leave, ws); // only once the new room has let us in
    }
    case 'rejoin': { // after a refresh or dropped connection
      const room = findRoom(m.code), seat = room && room.findSeat(m.token, m.me);
      if (!seat) return send(ws, { t: 'error', msg: 'That game has ended', code: 'gone' });
      room.reattach(seat, ws);
      return enter(ws, room, seat);
    }
    default:
      return send(ws, { t: 'error', msg: 'Create or join a room first' });
  }
}

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { onMessage(ws, m); } catch (err) { console.error('message failed', m.t, err); send(ws, { t: 'error', msg: 'Server error' }); }
  });
  ws.on('close', () => { if (ws.room && ws.seat.ws === ws) ws.room.disconnect(ws.seat); });
});

// Drop dead connections and close rooms nobody is in.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = room.async ? !room.inProgress && now - room.updatedAt > ASYNC_IDLE_TTL : room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL;
    if (idle) { room.dispose(); rooms.delete(code); store.remove(code); }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => console.log(`milkky server on ${HOST}:${PORT} (${rooms.size} rooms restored from ${store.dataDir})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  store.flush(); // write anything not yet saved
  wss.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref();
});
