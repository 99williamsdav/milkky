// The server holds up against misuse and its own mistakes: rooms nobody has a seat in close straight away, one
// address can only have so many rooms open, a flood of messages is cut off, and a saved room that breaks when it
// carries on is closed and set aside rather than crashing the server (again after every restart).
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tempDir, checks, client, is, sleep } from './helpers.mjs';

const PORT = 8098, DATA = tempDir();
// A saved league that restores fine but throws when its next round starts (its schedule has gone missing)
fs.mkdirSync(path.join(DATA, 'rooms'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'rooms', 'BADX.json'), JSON.stringify({
  v: 1, code: 'BADX', mode: 'league', pace: 'async', phase: 'between', target: 50, nextRoundAt: Date.now() - 1000, roundEndsAt: null,
  seats: [{ name: 'Ann', cpu: null, bot: null, token: 'tok', me: null, left: false, pid: '@ann' }],
  career: null, stepResults: {}, league: { round: 0, schedule: [], results: [], entries: [] }, matches: [],
}));
const srv = await startServer(PORT, { MILKKY_DATA_DIR: DATA, MILKKY_ROOMS_PER_ADDRESS: '3' });
const { check, finish } = checks(srv, 60_000);
const health = async () => (await (await fetch(`http://127.0.0.1:${PORT}/health`)).text()).trim();

// ---------- A broken saved room ----------
await sleep(500);
check(srv.exitCode === null, 'a saved room that throws when it carries on doesn’t crash the server');
check(await health() === 'ok 0 rooms', 'the broken room is closed');
check(fs.existsSync(path.join(DATA, 'rooms', 'BADX.json.bad')) && !fs.existsSync(path.join(DATA, 'rooms', 'BADX.json')),
  'its save is set aside, so it isn’t loaded again after a restart');

// ---------- Empty rooms close ----------
const A = client(PORT, 'Ann');
await A.open;
A.send({ t: 'create', name: 'Ann' });
await A.next(is('joined'));
A.send({ t: 'pace', pace: 'async' });
await A.next(m => m.t === 'room' && m.pace === 'async');
A.send({ t: 'leave' });
await sleep(200);
check(await health() === 'ok 0 rooms', 'leaving an async lobby you were alone in closes the room');

// ---------- Rooms per address ----------
const errors = [];
A.onMessage = m => { if (m.t === 'error') errors.push(m.msg); };
for (let i = 0; i < 4; i++) {
  A.send({ t: 'create', name: 'Ann' });
  await Promise.race([A.next(is('joined')), sleep(500)]);
  A.send({ t: 'detach' }); // keeps the seat, so the room stays open
}
await sleep(200);
check(await health() === 'ok 3 rooms', 'one address can only have 3 rooms open');
check(errors.some(e => /too many rooms/.test(e)), 'the next create is refused');

// ---------- Flooding ----------
const F = client(PORT, 'Flood');
await F.open;
let replies = 0;
F.onMessage = m => { if (m.t === 'pushKey') replies++; };
for (let i = 0; i < 500; i++) F.send({ t: 'pushKey' });
await sleep(500);
check(replies > 0 && replies < 100, `a burst of 500 messages is cut off (${replies} answered)`);

finish();
