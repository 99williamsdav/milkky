// Milkkshake: the rules on their own (pool turns, own goals, the squeeze, draws), a real online game against a
// computer player (24 bottles, everything knocked over parked), and a Milkkshake career.
import { startServer, checks, client, is } from './helpers.mjs';
import { newShake, shakeRestand, flavourOf, leftFor, NEAREST } from '../../src/shared/milkshake.js';
import { newPlayer, scoreThrow, advanceTurn, isGameOver } from '../../src/shared/rules.js';
import { shakePositions, RELEASE } from '../../src/shared/constants.js';
import { isParked } from '../../src/shared/battle.js';
import * as Career from '../../src/shared/career.js';

const PORT = 8089;
const srv = await startServer(PORT);
const { check, finish } = checks(srv, 180_000);

// ---------- The rules ----------
const game = (decisive = false) => { const g = { players: [newPlayer('Ann', null, 'red'), newPlayer('Bob', null, 'blue')], target: 50, winner: null }; newShake(g, 0, { decisive }); return g; };
check(shakePositions().length === 24 && shakePositions().every(p => p.flavour === flavourOf(p.num)), '24 bottles: 1–12 strawberry, 13–24 blueberry');
let g = game();
scoreThrow(g, [1, 2, 3]); advanceTurn(g);
check(g.cur === 0 && g.players[0].score === 3, 'a clean hit: Ann throws again');
scoreThrow(g, [4, 13]); advanceTurn(g);
check(g.cur === 1 && g.players[1].score === 1 && g.players[0].score === 4, 'hitting the other flavour (an own goal) passes the turn, and counts for them');
scoreThrow(g, []); advanceTurn(g);
check(g.cur === 0, 'a miss passes the turn');
// Down to the last strawberry: the squeeze
scoreThrow(g, [5, 6, 7, 8, 9, 10, 11]);
check(leftFor(g, 0) === 1 && g.shake.squeeze && g.cur === 0, 'down to the last bottle: the squeeze is on (a clean hit, so Ann throws again)');
scoreThrow(g, []);
check(g.cur === 1 && g.shake.squeezeNow, 'when the turn passes, the bottles are to move closer');
const poses = shakePositions().map(p => ({ t: { x: p.x, y: 0.075, z: p.z }, q: { x: 0, y: 0, z: 0, w: 1 }, num: p.num }));
const base = poses.map(p => ({ needs: false, x: p.t.x, z: p.t.z }));
const plan = shakeRestand(poses, base, g);
const dist = (x, z) => Math.hypot(x - RELEASE.x, z - RELEASE.z);
const live = plan.filter((p, i) => !g.shake.removed.includes(poses[i].num));
check(live.every((p, i) => p.needs) && live.every(p => dist(p.x, p.z) >= NEAREST - 1e-6) && plan.filter(p => p.gone).length === g.shake.removed.length,
  `every bottle left moves 50 cm closer (${dist(poses[23].t.x, poses[23].t.z).toFixed(2)} m → ${dist(plan[23].x, plan[23].z).toFixed(2)} m); knocked-over ones are parked`);
check(!g.shake.squeezeNow, 'once');
// The end: the last strawberry, by either player, wins it for Ann
scoreThrow(g, [12]);
check(isGameOver(g) && g.winner === g.players[0], 'knocking over the other player\'s last bottle hands them the win');
// Both cleared at once: a draw in a single game, the thrower's in a league
const ends = decisive => { const h = game(decisive); h.shake.removed = [...Array(11).keys()].map(i => i + 1).concat([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]); scoreThrow(h, [12, 24]); return h; };
check(ends(false).draw && !ends(false).winner, 'clearing both flavours at once is a draw');
check(ends(true).winner?.name === 'Ann' && !ends(true).draw, 'where a winner is needed, the thrower wins');

// ---------- An online game ----------
const A = client(PORT, 'Alice');
await A.open;
A.send({ t: 'create', name: 'Alice' });
await A.next(is('joined'));
A.send({ t: 'addCpu', level: 'medium' });
A.send({ t: 'variant', variant: 'milkshake' });
const lobby = await A.next(m => m.t === 'room' && m.variant === 'milkshake');
check(lobby.maxSeats === 4, 'a Milkkshake room takes up to 4');
let mine = null, players = [], ok = true, start = null;
A.onMessage = m => {
  if (m.t === 'start') { mine = m.match; players = m.game.players.map(p => p.name); start = m; }
  if (m.t === 'turn' && m.match === mine && !m.cpu && players[m.cur] === 'Alice') A.send({ t: 'throw', dist: 3.6 + Math.random() * 0.5, aim: (Math.random() - 0.5) * 0.2 });
  if (m.t === 'throw' && m.match === mine) {
    const s = m.game.shake;
    m.poses.forEach(([x, , z], i) => { if (s.removed.includes(shakePositions()[i].num) !== isParked(x, z)) ok = false; });
  }
};
A.send({ t: 'start' });
const last = await A.next(m => m.t === 'throw' && m.over);
const s = last.game.shake;
console.log(`${s.throws} throws; cleared: ${last.game.players.map(p => `${p.name} ${p.score}`).join(', ')}; ${last.game.draw ? 'a draw' : `winner ${players[last.game.winner]}`}. Last: "${last.msg}"`);
check(start.poses.length === 24 && start.game.shake, 'the game starts with 24 bottles');
check(last.game.winner >= 0 || last.game.draw, 'it ends with a winner (or a draw)');
check(ok, 'every bottle knocked over is parked, and only those');
check(last.game.players.every((p, i) => p.score === 12 - (12 - s.removed.filter(n => flavourOf(n) === (i ? 'blueberry' : 'strawberry')).length)), 'scores are each flavour cleared');

// ---------- 3 and 4 players ----------
// Every rack is fair: each flavour has the same share of each row and the same average distance and sideways spread
for (const n of [2, 3, 4]) {
  const r = shakePositions(n), per = r.length / n, rows = [...new Set(r.map(p => p.z.toFixed(3)))];
  const byF = f => r.filter(p => p.flavour === ['strawberry', 'blueberry', 'banana', 'chocolate'][f]);
  const mean = (a, k) => a.reduce((t, p) => t + k(p), 0) / a.length, spread = a => Math.max(...a) - Math.min(...a);
  const fair = [...Array(n).keys()].every(f => byF(f).length === per)
    && spread([...Array(n).keys()].map(f => mean(byF(f), p => Math.hypot(p.x - RELEASE.x, p.z - RELEASE.z)))) < 0.02 // within 2 cm as far
    && spread([...Array(n).keys()].map(f => mean(byF(f), p => Math.abs(p.x)))) < 0.12; // within 12 cm as central (3 players: the stagger)
  check(fair, `${n} players: ${per} each in a rack of ${r.length}, every flavour as near and as central as the others`);
}
const many = n => { const h = { players: ['Ann', 'Bob', 'Cat', 'Dan'].slice(0, n).map(x => newPlayer(x, null, 'red')), target: 50, winner: null }; newShake(h, 0); return h; };
g = many(3);
scoreThrow(g, [1]); scoreThrow(g, []);
check(g.cur === 1, '3 players: a miss passes the turn to the next player');
scoreThrow(g, [13, 25]);
check(g.cur === 2 && g.players[2].score === 1, 'knocking over another player’s bottles counts for them, and passes the turn');
// Bob's throw clears Cat's last banana: Cat wins
g = many(3); g.shake.removed = [25, 26, 27, 28, 29, 30, 31, 32]; g.cur = 1;
scoreThrow(g, [33]);
check(g.winner?.name === 'Cat', 'clearing someone else’s last bottle hands them the win');
// Dan's throw clears Ann's and Bob's at once: a draw; with his own among them: Dan wins
g = many(4); g.shake.removed = [...Array(11).keys()].map(k => k + 1).concat([...Array(11).keys()].map(k => k + 13)); g.cur = 3;
scoreThrow(g, [12, 24]);
check(g.draw && !g.winner, 'clearing two other flavours at once is a draw');
g = many(4); g.shake.removed = [...Array(11).keys()].map(k => k + 1).concat([...Array(11).keys()].map(k => k + 37)); g.cur = 3;
scoreThrow(g, [12, 48]);
check(g.winner?.name === 'Dan', 'clearing several including your own: you win');

// An online game for three
const T = client(PORT, 'Tess');
await T.open;
T.send({ t: 'create', name: 'Tess' });
await T.next(is('joined'));
T.send({ t: 'variant', variant: 'milkshake' });
T.send({ t: 'addCpu', level: 'medium' }); T.send({ t: 'addCpu', level: 'easy' });
await T.next(m => m.t === 'room' && m.seats.length === 3 && m.variant === 'milkshake');
let tm = null, tp = [], turns = new Set(), tok = true;
T.onMessage = m => {
  if (m.t === 'start') { tm = m.match; tp = m.game.players.map(p => p.name); }
  if (m.t === 'turn' && m.match === tm) turns.add(m.cur);
  if (m.t === 'turn' && m.match === tm && !m.cpu && tp[m.cur] === 'Tess') T.send({ t: 'throw', dist: 3.6 + Math.random() * 0.5, aim: (Math.random() - 0.5) * 0.2 });
  if (m.t === 'throw' && m.match === tm) m.poses.forEach(([x, , z], i) => { if (m.game.shake.removed.includes(shakePositions(3)[i].num) !== isParked(x, z)) tok = false; });
};
T.send({ t: 'start' });
const s3 = await T.next(m => m.t === 'start');
const end3 = await T.next(m => m.t === 'throw' && m.over);
console.log(`3 players: ${end3.game.shake.throws} throws; cleared ${end3.game.players.map(p => `${p.name} ${p.score}`).join(', ')}; ${end3.game.draw ? 'a draw' : `winner ${tp[end3.game.winner]}`}`);
check(s3.poses.length === 27 && s3.game.shake.per === 9, 'a 3-player game starts with 27 bottles, 9 each');
check(turns.size === 3 && tok && (end3.game.winner >= 0 || end3.game.draw), 'all three take turns, knocked-over bottles are parked, and it ends');

// ---------- A Milkkshake career ----------
const c = Career.newCareer({ people: ['@me'], variant: 'milkshake' });
while (!Career.seasonOver(c)) Career.playStep(c, {});
const all = c.leagues.flatMap(l => l.entries);
check(all.every(e => e.P === 7 && e.PF <= 84) && !!c.cup.winner, 'a Milkkshake career plays its season and cup');
finish();
