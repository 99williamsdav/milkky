// Online career: two people start a career, a third joins partway through the season and waits for the next,
// the server restarts mid-season, and someone who leaves is replaced by a bot when the season ends.
import { startServer, stopServer, tempDir, checks, client, is, sleep } from './helpers.mjs';
import * as C from '../../src/shared/career.js';

const PORT = 8094, DATA = tempDir();
const env = { MILKKY_DATA_DIR: DATA, MILKKY_ASYNC_BETWEEN_SECONDS: '0.2', MILKKY_SEASON_BREAK_SECONDS: '0.5' };
let srv = await startServer(PORT, env);
const { check, finish } = checks(() => srv, 300_000);

// The latest career state anyone has seen, and every room message with a career in it
const seen = { room: null, rooms: [], starts: [] };
let playing = true;
// A person who throws on their own turns in their own games
function person(name) {
  const c = client(PORT, name);
  let mine = null, players = [];
  const go = () => playing && c.send({ t: 'throw', dist: 3.4 + Math.random() * 0.8, aim: (Math.random() - 0.5) * 0.12 });
  c.onMessage = m => {
    if (m.t === 'room') { c.room = m; if (m.career) { seen.room = m; seen.rooms.push(m); } }
    if (m.t === 'start' || (m.t === 'sync' && m.game.players.some(p => p.name === name))) {
      mine = m.match; players = m.game.players.map(p => p.name);
      if (m.t === 'start') seen.starts.push({ who: name, match: m.match, players });
      if (m.t === 'sync' && m.turn && !m.turn.cpu && players[m.turn.cur] === name) go();
    }
    if (m.t === 'turn' && m.match === mine && !m.cpu && players[m.cur] === name) go();
  };
  return c;
}
const waitFor = async (pred, what, tries = 1200) => {
  for (let i = 0; i < tries; i++) { const r = pred(); if (r) return r; await sleep(100); }
  check(false, `timed out waiting for ${what}`); return null;
};
const career = () => seen.room?.career;

// ---------- Setting up ----------
let A = person('Alice'), B = person('Bob');
await Promise.all([A.open, B.open]);
const ALICE_KEY = 'alice-test-key-0123456789';
A.send({ t: 'create', name: 'Alice', me: ALICE_KEY });
const aJoined = await A.next(is('joined'));
const code = aJoined.code;
B.send({ t: 'join', code, name: 'Bob' });
const bJoined = await B.next(is('joined'));
A.send({ t: 'addCpu', level: 'easy' });
A.send({ t: 'mode', mode: 'career' });
A.send({ t: 'target', target: 20 });
const lobby = await A.next(m => m.t === 'room' && m.mode === 'career' && m.target === 20);
check(lobby.pace === 'async' && lobby.seats.length === 2 && lobby.maxSeats === 16, 'a career room is at your own pace, for up to 16, and brings its own bots');
A.send({ t: 'addCpu', level: 'easy' });
check((await A.next(is('error'))).msg.includes('own computer players'), 'you can\'t add bots to a career');
A.send({ t: 'pace', pace: 'live' });
check((await A.next(is('error'))).msg.includes('own pace'), 'a career can\'t be played live');

A.send({ t: 'start' });
const first = await waitFor(() => career(), 'the career to start');
const aId = A.room.career.you, bId = B.room.career.you;
check(C.tierOf(first.state, aId) === 2 && C.tierOf(first.state, bId) === 2 && first.state.tiers.every(t => t.length === 8),
  'Alice and Bob start in the Sunday League, three leagues of 8');
check(first.people[aId]?.name === 'Alice' && first.people[bId]?.name === 'Bob', 'the career says who the people are');
await waitFor(() => seen.starts.length >= 2, 'their first games');
const firstGames = seen.starts.slice(0, 2);
check(firstGames.every(s => s.players.length === 2 && s.players.some(n => / \(bot\)$/.test(n))), `their first games are against bots (${firstGames.map(s => s.players.join(' v ')).join('; ')})`);

// ---------- Someone joins partway through ----------
await waitFor(() => career()?.state.step >= 3, 'a few steps');
let D = person('Dan');
await D.open;
D.send({ t: 'join', code, name: 'Dan' });
const dJoined = await D.next(is('joined'));
const dRoom = await D.next(m => m.t === 'room' && m.career);
const dId = dRoom.career.you;
check(dRoom.career.state.waiting.includes(dId) && C.tierOf(dRoom.career.state, dId) === -1, 'Dan joins partway through the season and waits for the next');

// ---------- A restart in the middle of the season ----------
await waitFor(() => career()?.state.step >= 6, 'the middle of the season');
const stepBefore = career().state.step;
playing = false;
await sleep(800);
await stopServer(srv);
srv = await startServer(PORT, env);
playing = true;
const back = async (name, joined) => {
  const c = person(name); await c.open;
  c.send({ t: 'rejoin', code, token: joined.token });
  await c.next(is('joined'));
  return c;
};
A = await back('Alice', aJoined); B = await back('Bob', bJoined); D = await back('Dan', dJoined);
await waitFor(() => career()?.state.step > stepBefore, 'the season to carry on after the restart');
check(career().state.season === 1, `the career carried on after a restart (step ${stepBefore} → ${career().state.step})`);

// ---------- The end of the season ----------
const end = await waitFor(() => seen.rooms.find(r => r.career.state.season === 1 && C.seasonOver(r.career.state)), 'the end of season 1');
const s1 = end.career.state;
check(s1.leagues.every(lg => lg.entries.every(e => e.P === 7)), 'everyone played 7 league games');
check(!!s1.cup.winner, `the cup was won (by ${s1.cup.winner})`);
const pvp = s1.lastLeague.games.find(g => [g.a, g.b].sort().join() === [aId, bId].sort().join());
check(!!pvp, 'Alice and Bob played each other in the last league round');
check(end.phase === 'between' && end.career.nextStepIn > 0, 'a break before the next season');

const s2 = await waitFor(() => seen.rooms.find(r => r.career.state.season === 2)?.career, 'season 2');
check(C.tierOf(s2.state, dId) === 2 && !s2.state.waiting.length, 'Dan is in the Sunday League for season 2');
check(!!s2.state.summary.people[aId] && !!s2.state.summary.people[bId] && !s2.state.summary.people[dId], 'the season summary covers Alice and Bob');
check(new Set(s2.state.tiers.flat()).size === 24, 'still 24 players');

// Career stats: Alice's own, kept across the restart (7 league games, plus her cup ties)
const aStats = (await waitFor(() => A.room?.career?.state.season === 2 && A.room.career.stats, 'Alice\'s stats'));
const aCupTies = s1.cup.ties.filter(r => r.some(t => t.a === aId || t.b === aId)).length;
check(aStats.games === 7 + aCupTies && aStats.won + aStats.lost === aStats.games && aStats.cupPlayed === aCupTies,
  `Alice's stats count her ${aStats.games} games (7 league, ${aCupTies} cup): ${aStats.won} won, ${aStats.lost} lost`);
check(aStats.throws > 0 && aStats.points > 0 && aStats.bottles > 0 && aStats.seasons === 1, `and her throws (${aStats.throws} throws, ${aStats.points} points, ${aStats.bottles} bottles) and season`);
check(aStats.vs[bId]?.w + aStats.vs[bId]?.l >= 1, 'and her games against Bob (they meet in the league, and maybe the cup)');
check(!B.room?.career?.stats || B.room.career.stats !== aStats, 'each person only gets their own stats');

// ---------- Leaving ----------
B.send({ t: 'leave' });
await waitFor(() => career()?.people[bId]?.left, 'Bob to have left');
const s3 = await waitFor(() => seen.rooms.find(r => r.career.state.season === 3)?.career, 'season 3');
check(C.tierOf(s3.state, bId) === -1 && !s3.people[bId] && new Set(s3.state.tiers.flat()).size === 24,
  'Bob was played by a bot for the rest of the season, then a bot took his place');
check(C.tierOf(s3.state, aId) >= 0 && C.tierOf(s3.state, dId) >= 0, 'Alice and Dan are still in');

// ---------- My games ----------
A.send({ t: 'mine', me: ALICE_KEY });
const mine = (await A.next(is('mine'))).games.find(g => g.code === code);
check(mine?.mode === 'career' && mine.career.season === 3 && mine.career.place >= 1 && !mine.career.waiting,
  `My games shows the career: season ${mine?.career.season}, ${C.tierName(mine?.career.tier)}, place ${mine?.career.place}`);
finish();
