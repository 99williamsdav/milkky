// Games survive a server restart (e.g. a deploy): stop the server mid-game and mid-league, start it again
// on the same saved data, and check everyone can rejoin and finish.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, tempDir, checks, client, is, sleep } from './helpers.mjs';

const PORT = 8096, DATA = tempDir();
const env = { MILKKY_DATA_DIR: DATA, MILKKY_BETWEEN_SECONDS: '1' };
let srv = await startServer(PORT, env);
const { check, finish } = checks(() => srv, 180_000);

// A player that throws on its own turns while `playing` is on, and remembers the latest game events
const state = { playing: true, throws: 0, over: false, final: null };
function player(name) {
  const c = client(PORT, name);
  let mine = null, players = [];
  const myTurn = t => t && !t.cpu && players[t.cur] === name;
  const go = () => state.playing && c.send({ t: 'throw', dist: 3.4 + Math.random() * 0.8, aim: (Math.random() - 0.5) * 0.12 });
  c.onMessage = m => {
    if (m.t === 'start' || (m.t === 'sync' && m.game.players.some(p => p.name === name))) {
      mine = m.match; players = m.game.players.map(p => p.name);
      if (m.t === 'sync' && myTurn(m.turn)) go(); // our turn was waiting when we came back
    }
    if (m.match && m.match === mine && (m.t === 'turn' || m.t === 'throw')) c.lastEvent = { m, at: Date.now() };
    if (m.t === 'throw' && m.match === mine) { c.last = m; if (m.over) state.over = true; }
    if (m.t === 'throw') state.throws++;
    if (m.t === 'turn' && m.match === mine && myTurn(m)) go();
    if (m.t === 'room' && m.phase === 'over' && m.league) state.final = m;
  };
  return c;
}
// Stop throwing and wait until it's a person's turn with nothing happening, so the saved state is settled
async function pause(c) {
  state.playing = false;
  for (let i = 0; i < 200; i++) {
    await sleep(50);
    const e = c.lastEvent;
    if (e && e.m.t === 'turn' && !e.m.cpu && Date.now() - e.at > 700) return;
  }
}
async function restart() {
  await sleep(600); // let the last change reach the disk
  await stopServer(srv);
  srv = await startServer(PORT, env);
  state.playing = true;
}
const scores = g => g.players.map(p => `${p.name} ${p.score}/${p.misses}${p.out ? ' out' : ''}`).join(', ');

// ---------- Single game ----------
let A = player('Alice'), B = player('Bob');
await Promise.all([A.open, B.open]);
A.send({ t: 'create', name: 'Alice' });
const aJoined = await A.next(is('joined'));
B.send({ t: 'join', code: aJoined.code, name: 'Bob' });
const bJoined = await B.next(is('joined'));
A.send({ t: 'addCpu', level: 'medium' });
A.send({ t: 'start' });
for (let i = 0; i < 300 && state.throws < 5; i++) await sleep(50);
await pause(A);
const before = A.last;
check(!!before && fs.existsSync(path.join(DATA, 'rooms', `${aJoined.code}.json`)), `the room is saved to disk (${scores(before.game)})`);

await restart();
A = player('Alice'); B = player('Bob');
await Promise.all([A.open, B.open]);
A.send({ t: 'rejoin', code: aJoined.code, token: aJoined.token });
const sync = await A.next(m => m.t === 'sync' || m.t === 'error');
check(sync.t === 'sync', 'after a restart, Alice rejoins her game');
check(scores(sync.game) === scores(before.game) && sync.game.cur === before.game.cur, `scores and turn are as they were (${scores(sync.game)})`);
const drift = Math.max(...sync.poses.flatMap((p, i) => p.map((v, k) => Math.abs(v - before.poses[i][k]))));
check(drift < 1e-3, `every bottle is where it was (largest difference ${drift.toExponential(1)})`);
B.send({ t: 'rejoin', code: aJoined.code, token: bJoined.token });
for (let i = 0; i < 1200 && !state.over; i++) await sleep(50);
check(state.over, 'the game finishes after the restart');

// ---------- League ----------
A.send({ t: 'mode', mode: 'league' });
A.send({ t: 'target', target: 20 });
await A.next(m => m.t === 'room' && m.mode === 'league' && m.target === 20);
state.throws = 0;
A.send({ t: 'start' });
for (let i = 0; i < 400 && state.throws < 6; i++) await sleep(50);
await pause(A);
const roundBefore = [...A.inbox].reverse().find(m => m.t === 'room' && m.league)?.league.round;

await restart();
A = player('Alice'); B = player('Bob');
await Promise.all([A.open, B.open]);
A.send({ t: 'rejoin', code: aJoined.code, token: aJoined.token });
B.send({ t: 'rejoin', code: aJoined.code, token: bJoined.token });
const room = await A.next(m => m.t === 'room' && m.league);
check(room.mode === 'league' && room.league.round >= roundBefore, `the league carries on in round ${room.league.round} (was ${roundBefore})`);
for (let i = 0; i < 2400 && !state.final; i++) await sleep(50);
check(!!state.final, 'the league finishes after the restart');
if (state.final) {
  const lg = state.final.league;
  console.log('\nFinal table:\n' + lg.table.map((e, i) => `  ${i + 1}. ${e.name.padEnd(16)} P${e.P} W${e.W} L${e.L}`).join('\n'));
  check(lg.table.every(e => e.P === lg.rounds) && lg.results.length === lg.rounds * lg.table.length / 2, 'every fixture was played exactly once');
}

finish();
