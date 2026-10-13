// Battle mode: the rules on their own (legs, early finishes, countback), a real online battle against a computer
// player (bottles taken out are parked, the rack is reset for the second leg), and a battle career.
import { startServer, checks, client, is, sleep } from './helpers.mjs';
import { newBattle, battleThrow, battleWinner, BATTLE_THROWS, BOTTLES, isParked, AREA } from '../../src/shared/battle.js';
import { newPlayer, scoreThrow, advanceTurn, isGameOver } from '../../src/shared/rules.js';
import * as Career from '../../src/shared/career.js';
import { RELEASE } from '../../src/shared/constants.js';

const PORT = 8090;
const srv = await startServer(PORT);
const { check, finish } = checks(srv, 180_000);

// ---------- The rules ----------
const game = () => { const g = { players: [newPlayer('Ann', null, 'red'), newPlayer('Bob', null, 'blue')], target: 50, winner: null }; newBattle(g, 0); return g; };
const nums = n => Array.from({ length: n }, (_, i) => i + 1);
// Ann clears 12 in 4 throws (3 a time), Bob defending in between
let g = game(), taken = 0;
const order = [];
while (g.battle.leg === 0) {
  order.push(`${g.players[g.cur].name}:${g.battle.role}`);
  if (g.battle.role === 'attack') { scoreThrow(g, nums(12).slice(taken, taken + 3)); taken += 3; } else scoreThrow(g, [1]);
  advanceTurn(g);
}
check(order.join(' ') === 'Ann:attack Bob:defend Ann:attack Bob:defend Ann:attack Bob:defend Ann:attack', `turns alternate, attacker first, with no defending after the last bottle (${order.join(' ')})`);
check(g.battle.legs[0].throws === 4 && g.players[0].score === 12 && g.battle.resetRack && g.cur === 1 && g.battle.role === 'attack', 'leg 1 ends when all 12 are cleared; Bob attacks next, on a fresh rack');
g.battle.removed = []; g.battle.resetRack = false;
// Bob can no longer clear in fewer than 4: after his 4th throw (9 cleared) the battle ends
for (let k = 0; k < 4 && !isGameOver(g); k++) { if (g.battle.role === 'attack') scoreThrow(g, nums(12).slice(k * 3, k * 3 + (k === 3 ? 0 : 3))); else scoreThrow(g, []); if (g.battle.role === 'defend') scoreThrow(g, []); }
check(isGameOver(g) && g.winner === g.players[0], `Bob, unable to clear in fewer throws, has lost (${g.battle.legs[1].throws} throws, ${g.players[1].score} cleared)`);

// Neither clears: more bottles wins; level: countback
check(battleWinner([{ attacker: 0, throws: 20, cleared: 9, log: [] }, { attacker: 1, throws: 20, cleared: 10, log: [] }]) === 1, 'neither clears: more bottles wins');
check(battleWinner([{ attacker: 0, throws: 9, cleared: 12, log: [] }, { attacker: 1, throws: 8, cleared: 12, log: [] }]) === 1, 'both clear: fewer throws wins');
check(battleWinner([{ attacker: 0, throws: 20, cleared: 8, log: [3, 5, 8] }, { attacker: 1, throws: 20, cleared: 8, log: [4, 5, 8] }]) === 1, 'level: countback (whoever was ahead first)');
// The chaser wins as soon as they pass a first attacker who didn't clear them
g = game();
for (let k = 0; k < BATTLE_THROWS; k++) { scoreThrow(g, k < 5 ? [k + 1] : []); if (g.battle.leg === 0) scoreThrow(g, []); }
check(g.battle.leg === 1 && g.players[0].score === 5, 'out of throws: leg 1 ends on 5 cleared');
g.battle.removed = []; g.battle.resetRack = false;
scoreThrow(g, [1, 2, 3]); scoreThrow(g, []); scoreThrow(g, [4, 5, 6]);
check(isGameOver(g) && g.winner === g.players[1], 'the chaser wins as soon as they take a 6th');

// ---------- An online battle ----------
const A = client(PORT, 'Alice');
await A.open;
A.send({ t: 'create', name: 'Alice' });
await A.next(is('joined'));
A.send({ t: 'addCpu', level: 'medium' }); A.send({ t: 'addCpu', level: 'easy' });
A.send({ t: 'variant', variant: 'battle' });
check((await A.next(is('error'))).msg.includes('2 players'), 'a battle is for 2 players');
await A.next(m => m.t === 'room' && m.seats.length === 3);
A.send({ t: 'removeCpu', seat: 2 });
await A.next(m => m.t === 'room' && m.seats.length === 2);
A.send({ t: 'variant', variant: 'battle' });
const lobby = await A.next(m => m.t === 'room' && m.variant === 'battle');
check(lobby.maxSeats === 2, 'a battle room takes 2');
let mine = null, players = [], throwsSeen = [], legReset = false, parkedOk = true;
A.onMessage = m => {
  if (m.t === 'start') { mine = m.match; players = m.game.players.map(p => p.name); }
  if (m.t === 'turn' && m.match === mine && !m.cpu && players[m.cur] === 'Alice') A.send({ t: 'throw', dist: 3.5 + Math.random() * 0.6, aim: (Math.random() - 0.5) * 0.1 });
  if (m.t === 'throw' && m.match === mine) {
    const prev = throwsSeen.at(-1);
    throwsSeen.push(m);
    const b = m.game.battle;
    // Every removed bottle is parked; every other one is in the playing area
    m.poses.forEach(([x, , z], i) => {
      const gone = b.removed.includes([7, 9, 8, 5, 11, 12, 6, 3, 10, 4, 1, 2][i]); // (bottle numbers in rack order)
      const d = Math.hypot(x - RELEASE.x, z - RELEASE.z);
      if (gone ? !isParked(x, z) : (isParked(x, z) || d > AREA.far + 0.05)) parkedOk = false;
    });
    if (prev && prev.game.battle.leg === 0 && b.leg === 1) legReset = !b.removed.length && m.poses.every(([x, , z]) => !isParked(x, z));
  }
};
A.send({ t: 'start' });
const last = await A.next(m => m.t === 'throw' && m.over);
const b = last.game.battle;
console.log(`Legs: ${b.legs.map(l => `${players[l.attacker]} cleared ${l.cleared} in ${l.throws}`).join('; ')}. Winner: ${players[last.game.winner]}. Last: "${last.msg}"`);
check(b.legs[0].throws > 0 && b.legs[1].throws > 0 && last.game.winner >= 0, 'the battle is played over two legs and has a winner');
check(last.game.players.every((p, i) => p.score === b.legs.find(l => l.attacker === i).cleared), 'each player\'s score is the bottles they cleared');
check(legReset, 'the rack is fresh for the second leg');
check(parkedOk, 'bottles taken out are parked; the rest stay in the playing area');
check(throwsSeen.every(t => t.game.battle), 'every throw carries the battle\'s state');

// ---------- A battle career ----------
const c = Career.newCareer({ people: ['@me'], variant: 'battle' });
while (!Career.seasonOver(c)) Career.playStep(c, {});
const all = c.leagues.flatMap(l => l.entries);
check(c.variant === 'battle' && all.every(e => e.P === 7 && e.PF <= 7 * BOTTLES), `a battle career's games are battles (scores are bottles: most ${Math.max(...all.map(e => e.PF))} for in a season)`);
check(!!c.cup.winner, 'and its cup has a winner');

finish();
