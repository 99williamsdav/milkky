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
check(lobby.maxSeats === 2, 'a Milkkshake room takes 2');
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

// ---------- A Milkkshake career ----------
const c = Career.newCareer({ people: ['@me'], variant: 'milkshake' });
while (!Career.seasonOver(c)) Career.playStep(c, {});
const all = c.leagues.flatMap(l => l.entries);
check(all.every(e => e.P === 7 && e.PF <= 84) && !!c.cup.winner, 'a Milkkshake career plays its season and cup');
finish();
