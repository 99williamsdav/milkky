// Push notifications (logged to a file instead of sent): your turn while you're away (once, until you're back),
// nothing while you're looking, a reminder before an async round's deadline, and nothing new after a restart.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, tempDir, checks, client, is, sleep } from './helpers.mjs';

const PORT = 8091, DATA = tempDir(), LOG = path.join(DATA, 'push.log');
const env = { MILKKY_DATA_DIR: DATA, MILKKY_PUSH_LOG: LOG, MILKKY_ROUND_SECONDS: '6', MILKKY_REMIND_HOURS: String(3 / 3600) };
let srv = await startServer(PORT, env);
const { check, finish } = checks(() => srv, 120_000);
const sent = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const KEYS = { Alice: 'alice-push-test-key-0123456789', Bob: 'bob-push-test-key-0123456789' };
const sub = name => ({ endpoint: `https://push.example.com/${name}`, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });

// Subscribing
const q = client(PORT, 'q'); await q.open;
q.send({ t: 'pushKey' });
check((await q.next(is('pushKey'))).key === 'test-key', 'the server offers push');
q.send({ t: 'pushSubscribe', me: KEYS.Alice, sub: { endpoint: 'http://not-https', keys: {} } });
check(!(await q.next(is('pushSubscribed'))).ok, 'a bad subscription is refused');
for (const n of ['Alice', 'Bob']) { q.send({ t: 'pushSubscribe', me: KEYS[n], sub: sub(n) }); check((await q.next(is('pushSubscribed'))).ok, `${n} subscribes`); }

// An async game: Alice throws on her turns; Bob goes away
function player(name) {
  const c = client(PORT, name);
  let mine = null, players = [];
  c.auto = true;
  c.onMessage = m => {
    if (m.t === 'start') { mine = m.match; players = m.game.players.map(p => p.name); }
    if (m.t === 'turn' && m.match === mine && !m.cpu && players[m.cur] === name && c.auto)
      setTimeout(() => c.send({ t: 'throw', dist: 3.4 + Math.random() * 0.8, aim: (Math.random() - 0.5) * 0.12 }), 50);
  };
  return c;
}
const A = player('Alice'), B = player('Bob');
await Promise.all([A.open, B.open]);
A.send({ t: 'create', name: 'Alice', me: KEYS.Alice });
const { code } = await A.next(is('joined'));
B.send({ t: 'join', code, name: 'Bob', me: KEYS.Bob });
await B.next(is('joined'));
A.send({ t: 'pace', pace: 'async' });
A.send({ t: 'addCpu', level: 'easy' });
await A.next(m => m.t === 'room' && m.pace === 'async' && m.seats.length === 3);
B.auto = false;
B.send({ t: 'detach' }); // steps away, keeping the seat
await B.next(m => m.t === 'room');
A.send({ t: 'start' });
await sleep(4000);
let log = sent();
const forBob = log.filter(n => n.url === `/?room=${code}` && n.title === 'Your turn in Milkky');
check(forBob.length === 1, `Bob, away, is told it's his turn once (${forBob.length}: "${forBob[0]?.body}")`);
check(log.length === 1, `Alice, who is looking, gets nothing (${log.length} sent in all)`);

// Alice hides the page, and Bob comes back and takes his turn: Alice's next turn is notified
A.auto = false;
A.send({ t: 'visible', visible: false });
const B2 = client(PORT, 'Bob'); await B2.open;
B2.onMessage = m => {
  if (m.t === 'sync' && m.turn && !m.turn.cpu && m.game.players[m.turn.cur].name === 'Bob') B2.send({ t: 'throw', dist: 3.6, aim: 0 });
  if (m.t === 'turn' && !m.cpu && m.cur === 1) B2.send({ t: 'throw', dist: 3.6, aim: 0 });
};
B2.send({ t: 'join', code, name: 'Bob', me: KEYS.Bob });
await sleep(4000);
log = sent();
check(log.length === 2 && log[1].body.includes('Bob'), `Alice, with the page hidden, is told it's her turn ("${log[1]?.body}")`);

// A restart doesn't repeat them
await sleep(500);
await stopServer(srv);
srv = await startServer(PORT, env);
await sleep(1500);
check(sent().length === 2, 'nothing new after a restart');

// An async league round: a reminder before the deadline to people whose games aren't finished
const C = player('Cat'), D = player('Dan');
await Promise.all([C.open, D.open]);
C.send({ t: 'create', name: 'Cat', me: KEYS.Alice });
const c2 = (await C.next(is('joined'))).code;
D.send({ t: 'join', code: c2, name: 'Dan', me: KEYS.Bob });
await D.next(is('joined'));
C.send({ t: 'pace', pace: 'async' }); C.send({ t: 'mode', mode: 'league' });
await C.next(m => m.t === 'room' && m.mode === 'league' && m.pace === 'async');
C.auto = D.auto = false;
D.send({ t: 'detach' });
await D.next(m => m.t === 'room');
C.send({ t: 'start' });
await sleep(5500);
const reminders = sent().filter(n => /left to play/.test(n.title) && n.url === `/?room=${c2}`);
check(reminders.length === 1 && reminders[0].body.includes('Cat'), `Dan, away, is reminded before the round ends ("${reminders[0]?.title}: ${reminders[0]?.body}")`);
finish();
