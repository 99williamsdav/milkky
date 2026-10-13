// Battle: a two-player game in two legs. In each leg one player attacks and the other defends, taking turns
// (attacker first) at the same bottles. Bottles the attacker knocks over are taken out of the game; bottles the
// defender knocks over are stood up where they land, so the defender's job is to scatter them. The attacker has
// BATTLE_THROWS throws to clear all 12. Then the roles swap on a fresh rack.
//
// Whoever cleared all 12 in fewer throws wins; if neither did, whoever cleared more; if still level, countback
// (whoever was ahead first, throw by throw). Each player's `score` is the bottles they cleared as attacker, so
// tables, live scores and results work as they do for the classic game.
//
// Shared by the browser and the server: rules.js hands scoring, turns and re-standing over to these functions
// when a game has `battle` state. Bottles taken out are parked off the lawn (BATTLE_PARK) and hidden.
import { RELEASE, BOTTLE_R, clamp } from './constants.js';

export const BATTLE_THROWS = 20;
export const BOTTLES = 12;
// The playing area: 1 to 8.5 m from where you throw, up to 0.5 rad (about 29°) either side. Bottles knocked
// outside it are put back on its edge.
export const AREA = { near: 1.0, far: 8.5, side: 0.5 };
export const BATTLE_PARK = { x: 22, z: 22 }; // on the lawn (it ends 30 m out), well away from play
export const parkSpot = i => ({ x: BATTLE_PARK.x + (i % 4) * 0.3, z: BATTLE_PARK.z + Math.floor(i / 4) * 0.3 });
export const isParked = (x, z) => x > BATTLE_PARK.x - 5 && z > BATTLE_PARK.z - 5;

// Start a battle on a game (two players). first: who attacks in the first leg.
export function newBattle(game, first = 0) {
  game.cur = first;
  game.battle = {
    leg: 0, role: 'attack', removed: [], resetRack: false,
    // per leg: who attacks, attacking throws taken, bottles cleared, and bottles cleared after each attacking throw
    legs: [{ attacker: first, throws: 0, cleared: 0, log: [] }, { attacker: 1 - first, throws: 0, cleared: 0, log: [] }],
  };
  for (const p of game.players) p.score = 0;
  return game.battle;
}
export const legOf = game => game.battle.legs[game.battle.leg];
export const attackerOf = game => legOf(game).attacker;
export const defenderOf = game => 1 - legOf(game).attacker;
export const roleOf = (game, i) => (i === attackerOf(game) ? 'attack' : 'defend');

// A throw by the current player knocked over `fallenNums`. Updates the battle (and, when it ends, the winner);
// returns the message to show.
export function battleThrow(game, fallenNums) {
  const b = game.battle, leg = legOf(game), p = game.players[game.cur];
  fallenNums = fallenNums.filter(num => !b.removed.includes(num)); // (anything already out doesn't count again)
  const n = fallenNums.length;
  let msg;
  if (b.role === 'attack') {
    leg.throws++;
    for (const num of fallenNums) if (!b.removed.includes(num)) b.removed.push(num);
    leg.cleared = b.removed.length; p.score = leg.cleared;
    leg.log.push(leg.cleared);
    const left = BOTTLES - leg.cleared;
    msg = !n ? `Miss · ${left} left` : `${n} bottle${n === 1 ? '' : 's'} taken out · ${left} left`;
    const legOver = left === 0 || leg.throws >= BATTLE_THROWS;
    if (legOver) {
      msg = left === 0 ? `${p.name} cleared all ${BOTTLES} in ${leg.throws} throws` : `Out of throws: ${p.name} cleared ${leg.cleared} of ${BOTTLES}`;
      if (b.leg === 0) { b.leg = 1; b.resetRack = true; b.role = 'attack'; game.cur = legOf(game).attacker; msg += '!'; }
      else { decide(game); msg += `. ${winsText(game.winner)}`; }
      return msg;
    }
    // The second leg stops as soon as it's settled: the chaser can no longer clear them in fewer throws, or
    // (when the first attacker didn't clear them) has already taken more
    if (b.leg === 1) {
      const first = b.legs[0];
      const beaten = first.cleared === BOTTLES && leg.throws >= first.throws;
      const won = first.cleared < BOTTLES && leg.cleared > first.cleared;
      if (beaten || won) { decide(game); return `${msg}. ${winsText(game.winner)}`; }
    }
    b.role = 'defend'; game.cur = 1 - game.cur;
  } else {
    msg = !n ? 'Missed: nothing scattered' : `Scattered ${n} bottle${n === 1 ? '' : 's'}`;
    b.role = 'attack'; game.cur = 1 - game.cur;
  }
  return msg;
}
const winsText = p => `${p.name} ${p.name === 'You' ? 'win' : 'wins'}!`;
// The battle is over: pick the winner
function decide(game) {
  game.winner = game.players[battleWinner(game.battle.legs)];
  game.battle.over = true;
}
// Who wins two legs ([{ attacker, throws, cleared, log }]): the player index
export function battleWinner([L0, L1]) {
  const time = L => (L.cleared === BOTTLES ? L.throws : Infinity);
  if (time(L0) !== time(L1)) return (time(L0) < time(L1) ? L0 : L1).attacker;
  if (L0.cleared !== L1.cleared) return (L0.cleared > L1.cleared ? L0 : L1).attacker;
  // Countback: whoever was ahead first after the same number of throws (identical all the way: the first attacker,
  // who set the mark)
  for (let k = 0; k < Math.max(L0.log.length, L1.log.length); k++) {
    const a = L0.log[Math.min(k, L0.log.length - 1)] ?? 0, c = L1.log[Math.min(k, L1.log.length - 1)] ?? 0;
    if (a !== c) return (a > c ? L0 : L1).attacker;
  }
  return L0.attacker;
}
// In the second leg, what the chaser needs, in words: "Clear all 12 in 13 throws" or "Take 10 to win"
export function chaseText(game) {
  const b = game.battle, [L0] = b.legs;
  if (b.leg !== 1 || b.over) return '';
  return L0.cleared === BOTTLES ? `Clear all ${BOTTLES} in ${L0.throws - 1} throw${L0.throws === 2 ? '' : 's'} to win`
    : `Take ${L0.cleared + 1} to win`;
}

// Where bottles go after a throw (poses: [{ t, q, num }] in bottle order; base: the classic plan of who needs standing
// up, from rules.js). Bottles taken out go to their parking spot; every bottle still in play that's outside the
// area is put back on its edge. Returns [{ needs, x, z, gone }].
export function battleRestand(poses, base, game) {
  const removed = new Set(game.battle.removed);
  const plan = base.map((p, i) => {
    if (removed.has(poses[i].num)) return { needs: true, gone: true, ...parkSpot(i) };
    let { x, z, needs } = p;
    const dx = x - RELEASE.x, dz = z - RELEASE.z, d = Math.hypot(dx, dz), a = Math.atan2(dx, -dz);
    const cd = clamp(d, AREA.near, AREA.far), ca = clamp(a, -AREA.side, AREA.side);
    if (cd !== d || ca !== a) { needs = true; x = RELEASE.x + Math.sin(ca) * cd; z = RELEASE.z - Math.cos(ca) * cd; }
    return { needs, x, z };
  });
  // Two bottles put back on the same bit of edge: nudge them apart
  const live = plan.filter(p => !p.gone), min = 2 * BOTTLE_R + 0.006;
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const A = live[i], B = live[j], d = Math.hypot(B.x - A.x, B.z - A.z);
      if (d >= min || (!A.needs && !B.needs)) continue;
      const nx = d > 1e-6 ? (B.x - A.x) / d : 1, nz = d > 1e-6 ? (B.z - A.z) / d : 0, push = min - d;
      const mover = B.needs ? B : A, s = mover === B ? 1 : -1;
      mover.x += s * nx * push; mover.z += s * nz * push;
    }
  }
  return plan;
}
// The bottles still in play, from a list of spots ({ bottle: { num }, x, z })
export const liveSpots = (game, spots) => (game.battle ? spots.filter(s => !game.battle.removed.includes(s.bottle.num)) : spots);
