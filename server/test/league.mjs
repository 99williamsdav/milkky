// League: rounds of simultaneous fixtures, live scores, watching another game, and the final table.
import { startServer, checks, client, is, sleep } from './helpers.mjs';

const PORT = 8097;
const srv = await startServer(PORT, { MILKKY_BETWEEN_SECONDS: '1' });
const { check, finish } = checks(srv);

const A = client(PORT, 'Alice'), B = client(PORT, 'Bob');
await Promise.all([A.open, B.open]);
A.send({ t: 'create', name: 'Alice' });
const { code } = await A.next(is('joined'));
B.send({ t: 'join', code, name: 'Bob (bot)' });
await B.next(is('joined'));
const bName = (await B.next(m => m.t === 'room' && m.seats.length === 2)).seats[1].name;
check(bName === 'Bob', `a person can't pass as a bot ("Bob (bot)" became "${bName}")`);

B.send({ t: 'mode', mode: 'league' });
check((await B.next(is('error'))).msg.startsWith('Only the host'), 'only the host can switch to a league');
A.send({ t: 'mode', mode: 'league' });
A.send({ t: 'target', target: 20 });
A.send({ t: 'addCpu', level: 'easy' });
const lobby = await A.next(m => m.t === 'room' && m.mode === 'league' && m.seats.length === 3 && m.target === 20);
check(lobby.maxSeats === 8, 'a league room takes up to 8 players');

// Each player throws on their own turns, and watches another fixture once theirs is done.
const stats = { fixtures: 0, watched: new Set(), rounds: new Set() };
function autoplay(c, name) {
  let mine = null, players = [];
  c.onMessage = m => {
    if (m.t === 'fixtures') stats.fixtures++;
    if (m.t === 'start') { mine = m.match; players = m.game.players.map(p => p.name); stats.rounds.add(m.match.split('-')[0]); }
    if (m.t === 'turn' && m.match === mine && !m.cpu && players[m.cur] === name) {
      c.send({ t: 'throw', dist: 3.4 + Math.random() * 0.8, aim: (Math.random() - 0.5) * 0.12 });
    }
    if (m.t === 'throw' && m.match === mine && m.over) c.lastFixtures = null, c.send({ t: 'watch', match: c.other?.id });
    if (m.t === 'fixtures' || m.t === 'room') c.other = (m.fixtures || []).find(f => f.id !== mine && !f.over);
    if (m.t === 'sync' && m.match !== mine) stats.watched.add(m.match);
  };
}
autoplay(A, 'Alice'); autoplay(B, 'Bob');
A.send({ t: 'start' });

let final = null;
for (let i = 0; i < 1200 && !final; i++) {
  await sleep(100);
  const r = A.inbox.find(m => m.t === 'room' && m.mode === 'league' && m.phase === 'over' && m.league);
  if (r) final = r;
}
check(!!final, 'the league finishes');
const lg = final.league;
console.log('\nFinal table:\n' + lg.table.map((e, i) => `  ${i + 1}. ${e.name.padEnd(18)} P${e.P} W${e.W} L${e.L} ${e.PF}:${e.PA}`).join('\n'));
check(lg.rounds === 3 && lg.table.length === 4, '3 players plus a filler make 4 entries and 3 rounds');
check(lg.table.every(e => e.P === 3), 'everyone played everyone once');
const humansGame = lg.results.find(r => [r.a, r.b].sort().join() === 'Alice,Bob');
check(humansGame?.round === lg.rounds, `the two people play each other in the last round (round ${humansGame?.round} of ${lg.rounds})`);
check(lg.table.reduce((n, e) => n + e.W, 0) === 6 && lg.results.length === 6, '6 fixtures, 6 winners');
check(lg.table.filter(e => e.cpu).length === 2 && lg.table.every(e => !e.cpu || / \(bot\)$/.test(e.name)) && lg.table.some(e => e.cpu === 'medium' && e.seat === -1),
  `a bot filler evened the numbers, and bots are named as bots (${lg.table.filter(e => e.cpu).map(e => e.name).join(', ')})`);
check(stats.rounds.size === 3, `players were sent their fixtures for each round (${[...stats.rounds].join(', ')})`);
check(stats.fixtures > 6, `live scores were sent during play (${stats.fixtures} updates)`);
check(stats.watched.size > 0, `players watched other fixtures after finishing (${[...stats.watched].join(', ')})`);

finish();
