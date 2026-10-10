// Async ("take your time") league: people come and go, seats are kept, each round has a deadline
// (moving on early when its games are done), and returning players catch up on throws they missed.
import { startServer, checks, client, is, sleep } from './helpers.mjs';

const PORT = 8095;
// Short live timers prove they don't apply to async games; an 8 s round stands in for a day.
const srv = await startServer(PORT, { MILKKY_TURN_SECONDS: '2', MILKKY_AWAY_SECONDS: '1', MILKKY_ROUND_SECONDS: '8', MILKKY_ASYNC_BETWEEN_SECONDS: '1' });
const { check, finish } = checks(srv, 180_000);

const KEYS = { Alice: 'alice-key-0123456789abcdef', Bob: 'bob-key-0123456789abcdef' };
let code;

// Connect as `name`; `throwsLeft` limits how many turns they take before stepping away (Infinity: play on)
async function visit(name, { join = false, throwsLeft = Infinity } = {}) {
  const c = client(PORT, name);
  await c.open;
  let mine = null, players = [];
  c.got = []; // game messages, in order
  const go = () => { if (throwsLeft-- > 0) { c.send({ t: 'throw', dist: 3.4 + Math.random() * 0.8, aim: (Math.random() - 0.5) * 0.12 }); c.thrown = true; } else c.done = true; };
  const myTurn = t => t && !t.cpu && players[t.cur] === name;
  c.onMessage = m => {
    if (['sync', 'turn', 'throw', 'start'].includes(m.t)) c.got.push(m);
    if (m.t === 'start' || (m.t === 'sync' && m.game.players.some(p => p.name === name))) {
      mine = m.match; players = m.game.players.map(p => p.name);
      if (m.t === 'sync' && !m.replay && myTurn(m.turn)) go();
    }
    if (m.t === 'turn' && m.match === mine && myTurn(m)) go();
    if (m.t === 'throw' && c.thrown && throwsLeft <= 0) c.done = true; // our throw has played: step away
  };
  c.send(join ? { t: 'join', code, name, me: KEYS[name] } : { t: 'rejoin', code, me: KEYS[name] });
  c.joined = await c.next(m => m.t === 'joined' || m.t === 'error');
  return c;
}
const away = c => c.ws.terminate();
async function mine(name) {
  const c = client(PORT, 'list'); await c.open;
  c.send({ t: 'mine', me: KEYS[name] });
  const r = await c.next(is('mine')); c.ws.close();
  return r.games.find(g => g.code === code);
}

// ---------- Set up ----------
const A0 = client(PORT, 'Alice'); await A0.open;
A0.send({ t: 'create', name: 'Alice', me: KEYS.Alice });
code = (await A0.next(is('joined'))).code;
for (const m of [{ t: 'pace', pace: 'async' }, { t: 'mode', mode: 'league' }, { t: 'target', target: 20 }]) A0.send(m);
await A0.next(m => m.t === 'room' && m.pace === 'async' && m.mode === 'league' && m.target === 20);
// Seats: Alice, Bob, a bot, plus a filler bot to make 4. Rounds: Alice v filler, Alice v bot, Alice v Bob.
const B0 = await visit('Bob', { join: true, throwsLeft: 0 });
away(B0);
A0.send({ t: 'addCpu', level: 'easy' });
await A0.next(m => m.t === 'room' && m.seats.length === 3);
await sleep(1500); // longer than a live lobby would wait... but async seats aren't let go
const lobby = await mine('Bob');
check(lobby && lobby.phase === 'lobby', 'Bob keeps his lobby seat while away');
A0.send({ t: 'start' });
await A0.next(is('start'));
away(A0);

// ---------- Round 1: nobody here, nobody stood in for ----------
await sleep(3000); // well past the live turn and away timers
let a = await mine('Alice');
check(a.match.yourTurn && a.match.players.every(p => p.score === 0) && !a.match.unseen, 'Alice’s turn waits for her (no bot stepped in)');
check(a.host, 'Alice is still the host while away');
check(a.league.round === 1 && a.league.roundEndsIn > 0, `round 1 of ${a.league.rounds}, ends in ${Math.round(a.league.roundEndsIn / 1000)} s`);

// Alice comes back with her key and plays her whole fixture; Bob's game is still waiting for him.
const A1 = await visit('Alice');
for (let i = 0; i < 40 && !A1.got.some(m => m.t === 'sync'); i++) await sleep(50);
check(A1.joined.t === 'joined' && A1.got.some(m => m.t === 'sync'), 'Alice rejoins with her player key');
for (let i = 0; i < 100 && !A1.got.some(m => m.t === 'throw' && m.over); i++) await sleep(50);
a = await mine('Alice');
check(a.league.round === 1 && a.match.over, 'her game is done, but the round waits for Bob');
const B1 = await visit('Bob', { join: true, throwsLeft: 0 }); // following the link again
check(B1.joined.you === B0.joined.you && B1.joined.token === B0.joined.token, 'following the room link again gets Bob his own seat back');
away(B1);

// The deadline passes: bots finish Bob's game, there's a pause to look at the table, and round 2 starts.
let paused = false;
for (let i = 0; i < 60; i++) { await sleep(200); const g = await mine('Alice'); if (g.phase === 'between') paused = true; if (g.league.round === 2 && g.phase === 'playing') break; }
check(paused, 'there was a pause between rounds');
a = await mine('Alice');
check(a.league.round === 2, `after the deadline, round ${a.league.round} has started`);

// ---------- Round 2: Alice plays; Bob's game is finished by bots at the deadline ----------
for (let i = 0; i < 200 && !A1.got.some(m => m.t === 'throw' && m.over && m.match.startsWith('r2')); i++) await sleep(50);
away(A1);
for (let i = 0; i < 200 && (await mine('Alice')).league.round < 3; i++) await sleep(200);
a = await mine('Alice');
check(a.league.round === 3 && a.match.players.map(p => p.name).join(' v ') === 'Alice v Bob', `round 3 is ${a.match.players.map(p => p.name).join(' v ')}`);

// ---------- Round 3: head to head, taking turns at leisure ----------
let replays = 0;
for (let turn = 0; turn < 4; turn++) {
  const who = a.match.yourTurn ? 'Alice' : 'Bob';
  const c = await visit(who, { throwsLeft: 1 });
  for (let i = 0; i < 100 && !c.done && !c.got.some(m => m.t === 'throw' && m.over); i++) await sleep(50);
  const sync = c.got.find(m => m.t === 'sync');
  if (turn > 0 && sync?.replay) {
    const shown = c.got.filter(m => m.t === 'throw').slice(0, sync.replay);
    // what they missed: the other player's throws, before their own turn
    if (shown.length === sync.replay && shown.every(t => t.game.players[t.seat].name !== who)) replays++;
  }
  await sleep(200);
  away(c);
  a = await mine(who === 'Alice' ? 'Bob' : 'Alice');
  if (!a || a.match.over) break;
  a = await mine('Alice');
}
check(replays >= 2, `coming back, each player first watched the throws they missed (${replays} catch-ups)`);

// Nobody finishes round 3 by hand: the deadline does it, and that's the last round.
let final = null;
for (let i = 0; i < 100 && !final; i++) {
  await sleep(200);
  const g = await mine('Alice');
  if (g.phase === 'over') final = g;
}
check(!!final, 'the league finishes');
const R = client(PORT, 'final'); await R.open;
R.send({ t: 'rejoin', code, me: KEYS.Alice });
const room = await R.next(m => m.t === 'room' && m.league);
const lg = room.league;
console.log('\nFinal table:\n' + lg.table.map((e, i) => `  ${i + 1}. ${e.name.padEnd(16)} P${e.P} W${e.W} L${e.L}`).join('\n'));
check(lg.table.every(e => e.P === 3) && lg.results.length === 6, 'every fixture was played once');

finish();
