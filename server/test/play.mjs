// End-to-end check: start the server, have two people and a computer play a full game.
// Run with `npm test` from server/. Animation waits are switched off so it finishes quickly.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 8099;
const srv = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), MILKKY_ANIM_SCALE: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => { srv.stdout.once('data', res); srv.once('exit', c => rej(new Error('server exited ' + c))); });

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const done = code => { srv.kill(); process.exit(code); };
setTimeout(() => { console.log('FAIL timed out'); done(1); }, 120_000).unref();

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { name, ws, inbox: [], waiters: [], throws: [], maxBytes: 0 };
  ws.on('message', data => {
    c.maxBytes = Math.max(c.maxBytes, data.length);
    const m = JSON.parse(data);
    if (m.t === 'throw') c.throws.push(m);
    const w = c.waiters.findIndex(w => w.pred(m));
    if (w >= 0) c.waiters.splice(w, 1)[0].res(m); else c.inbox.push(m);
  });
  c.send = m => ws.send(JSON.stringify(m));
  // Resolve with the first message (already received or future) matching pred
  c.next = pred => {
    const i = c.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(c.inbox.splice(i, 1)[0]);
    return new Promise(res => c.waiters.push({ pred, res }));
  };
  c.open = new Promise(res => ws.once('open', res));
  return c;
}
const is = t => m => m.t === t;

// ---------- Lobby ----------
const A = client('Alice'), B = client('Bob');
await Promise.all([A.open, B.open]);
A.send({ t: 'create', name: 'Alice<script>' });
const aJoined = await A.next(is('joined'));
check(/^[A-Z]{4}$/.test(aJoined.code), `room created: ${aJoined.code}`);
B.send({ t: 'join', code: 'ZZZZ', name: 'Bob' });
check((await B.next(is('error'))).msg === 'No room with that code', 'unknown code rejected');
B.send({ t: 'join', code: aJoined.code.toLowerCase(), name: 'Bob' });
const bJoined = await B.next(is('joined'));
check(bJoined.you === 1, 'Bob joins as seat 1');
B.send({ t: 'start' });
check((await B.next(is('error'))).msg === 'Only the host can start', 'only host can start');
A.send({ t: 'addCpu', level: 'hard' });
A.send({ t: 'target', target: 30 });
const room = await A.next(m => m.t === 'room' && m.seats.length === 3 && m.target === 30);
check(room.seats.map(s => s.name).join(',') === 'Alicescript,Bob,Computer (Hard)', `seats: ${room.seats.map(s => s.name).join(', ')}`);

// ---------- Game ----------
A.send({ t: 'start' });
const started = await B.next(is('start'));
check(started.game.players.length === 3 && started.poses.length === 12, 'game starts with 3 players and 12 bottles');

let wrongTurnChecked = false, badThrowChecked = false, rejoinChecked = false, throwsSeen = 0;
const me = { 0: A, 1: B };
for (;;) {
  const m = await A.next(m => m.t === 'turn' || (m.t === 'throw' && m.over));
  if (m.t === 'throw') break;
  const thrower = me[m.cur];
  if (!thrower) { check(!!m.cpu && typeof m.cpu.target === 'number', `computer plans a throw at bottle ${m.cpu?.target}`); continue; }
  const other = thrower === A ? me[1] : A;
  if (!wrongTurnChecked) {
    other.send({ t: 'throw', dist: 3.6, aim: 0 });
    check((await other.next(is('error'))).msg === 'Not your turn', 'out-of-turn throw rejected');
    wrongTurnChecked = true;
  }
  if (!badThrowChecked) {
    thrower.send({ t: 'throw', dist: 'far', aim: 0 });
    check((await thrower.next(is('error'))).msg === 'Bad throw', 'malformed throw rejected');
    badThrowChecked = true;
  }
  if (!rejoinChecked && thrower === A && throwsSeen >= 2) {
    // Bob drops and comes back mid-game
    B.ws.terminate();
    const B2 = client('Bob again'); await B2.open;
    B2.send({ t: 'rejoin', code: aJoined.code, token: bJoined.token });
    const sync = await B2.next(is('sync'));
    check(sync.game.cur === m.cur && sync.poses.length === 12, 'Bob rejoins and gets the current game');
    me[1] = B2; B2.throws = B.throws; rejoinChecked = true;
  }
  thrower.send({ t: 'aim', aim: 0.02, pull: 0.5 });
  thrower.send({ t: 'throw', dist: 3.4 + Math.random() * 0.9, aim: (Math.random() - 0.5) * 0.12 });
  throwsSeen++;
}

// ---------- Results ----------
const bLast = await me[1].next(m => m.t === 'throw' && m.over), last = A.throws.at(-1);
const winner = last.game.winner >= 0 ? last.game.players[last.game.winner].name : 'nobody (all out)';
console.log(`\n${A.throws.length} throws. Last: "${last.msg}". Winner: ${winner}`);
console.log('Scores:', last.game.players.map(p => `${p.name} ${p.score}${p.out ? ' (out)' : ''}`).join(', '));
check(JSON.stringify(last.game) === JSON.stringify(bLast.game), 'both players see the same final state');
check(last.game.winner >= 0 ? last.game.players[last.game.winner].score === 30 || last.game.players.filter(p => !p.out).length === 1 : true, 'winner is valid');
const lens = A.throws.map(t => t.frames.length);
console.log(`Frames per throw: min ${Math.min(...lens)}, max ${Math.max(...lens)}; largest message ${(A.maxBytes / 1024).toFixed(1)} KB`);
check(A.throws.every(t => t.bodies.includes(12) && t.frames.every(f => f.length === 7 * t.bodies.length)), 'frames hold a pose for each moving body, stick included');
console.log(`Bottles moving per throw: ${A.throws.map(t => t.bodies.length - 1).join(' ')}`);
const over = await A.next(m => m.t === 'room' && m.phase === 'over');
check(over.seats.length === 3, 'room returns to the lobby after the game');

// ---------- Moving to another room ----------
// Alice follows a link elsewhere: her old seat should only go once the new room accepts her.
const A2 = client('Alice elsewhere'); await A2.open;
A2.send({ t: 'join', code: 'ZZZZ', name: 'Alice', leave: { code: aJoined.code, token: aJoined.token } });
await A2.next(is('error'));
await new Promise(r => setTimeout(r, 200));
check(!me[1].inbox.some(m => m.t === 'room' && !m.seats.some(s => s.name.startsWith('Alice'))), 'a failed join keeps the old seat');
A2.send({ t: 'create', name: 'Alice', leave: { code: aJoined.code, token: aJoined.token } });
const moved = await A2.next(is('joined'));
const bRoom = await me[1].next(m => m.t === 'room' && !m.seats.some(s => s.name.startsWith('Alice')));
check(moved.code !== aJoined.code && bRoom.seats.length === 2, 'Alice moves to a new room and her old seat is freed');

// ---------- Refreshing in the lobby ----------
const C = client('Cara'); await C.open;
C.send({ t: 'join', code: moved.code, name: 'Cara' });
const cJoined = await C.next(is('joined'));
C.ws.terminate(); // e.g. a page refresh
const away = await A2.next(m => m.t === 'room' && m.seats.some(s => s.name === 'Cara' && !s.connected));
check(away.seats.length === 2, 'a dropped lobby player is shown as away, not removed');
const C2 = client('Cara again'); await C2.open;
C2.send({ t: 'rejoin', code: moved.code, token: cJoined.token });
check((await C2.next(m => m.t === 'joined' || m.t === 'error')).t === 'joined', 'they get their lobby seat back');
C2.send({ t: 'leave' });
const gone = await A2.next(m => m.t === 'room' && !m.seats.some(s => s.name === 'Cara'));
check(gone.seats.length === 1, 'choosing to leave frees the seat straight away');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
done(failures ? 1 : 0);
