// Milkky game server. WebSocket on /ws, health check on /health.
// Meant to sit behind nginx: listens on 127.0.0.1 unless HOST says otherwise.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import RAPIER_MOD from '@dimforge/rapier3d-compat';
import { Room } from './room.js';

const RAPIER = RAPIER_MOD.default || RAPIER_MOD;
await RAPIER.init();

const PORT = +process.env.PORT || 8080, HOST = process.env.HOST || '127.0.0.1';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const MAX_ROOMS = 500;
const EMPTY_ROOM_TTL = 2 * 60 * 1000; // close a room this long after the last person leaves

const rooms = new Map();
function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
    if (!rooms.has(code)) return code;
  }
}
const findRoom = code => rooms.get(String(code ?? '').toUpperCase().trim());

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
  if (room.game && room.phase === 'playing') send(ws, room.syncState());
}

function onMessage(ws, m) {
  if (ws.room) {
    if (m.t === 'leave') { const { room, seat } = ws; ws.room = ws.seat = null; return room.disconnect(seat); }
    return ws.room.handle(ws.seat, m);
  }
  switch (m.t) {
    case 'create': {
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'The server is full, try again later' });
      const room = new Room(newCode(), RAPIER);
      rooms.set(room.code, room);
      return enter(ws, room, room.addHuman(ws, m.name));
    }
    case 'join': {
      const room = findRoom(m.code);
      if (!room) return send(ws, { t: 'error', msg: 'No room with that code' });
      if (!room.canJoin()) return send(ws, { t: 'error', msg: room.phase === 'playing' ? 'That game has already started' : 'That room is full' });
      return enter(ws, room, room.addHuman(ws, m.name));
    }
    case 'rejoin': { // after a refresh or dropped connection
      const room = findRoom(m.code), seat = room && room.seats.find(s => s.token && s.token === m.token);
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
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL) { room.dispose(); rooms.delete(code); }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => console.log(`milkky server on ${HOST}:${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { wss.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
