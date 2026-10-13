// Milkkshake: a two-player game with 12 strawberry and 12 blueberry bottles (constants.js shakePositions), the first
// player strawberry. Anything knocked over leaves the game, whoever's it is; the first flavour to be cleared wins
// (so knocking over your opponent's bottles helps them). Pool rules: after a clean hit (some of yours, none of
// theirs) you throw again; otherwise the turn passes. Once anyone is down to their last bottle, every bottle left
// moves SQUEEZE closer each time the turn passes (no nearer than NEAREST). A throw that clears both flavours is a
// draw, except where a winner is needed (leagues, careers: `decisive`), when the thrower wins.
//
// Each player's `score` is how much of their flavour has been cleared. Shared by the browser and the server:
// rules.js hands scoring, turns and re-standing over to these functions when a game has `shake` state.
import { RELEASE, BOTTLE_R } from './constants.js';
import { parkSpot } from './battle.js';

export const FLAVOURS = ['strawberry', 'blueberry'];
export const PER_FLAVOUR = 12;
export const SQUEEZE = 0.5, NEAREST = 1.5;
export const flavourOf = num => (num <= PER_FLAVOUR ? 'strawberry' : 'blueberry');
export const FLAVOUR_NAME = { strawberry: 'Strawberry', blueberry: 'Blueberry' };

export function newShake(game, first = 0, { decisive = false } = {}) {
  game.cur = first;
  game.shake = { removed: [], squeeze: false, squeezeNow: false, streak: 0, decisive, throws: 0, log: [] };
  for (const p of game.players) p.score = 0;
  return game.shake;
}
export const flavourOfPlayer = i => FLAVOURS[i];
// How many of a player's flavour are left
export const leftFor = (game, i) => PER_FLAVOUR - game.shake.removed.filter(n => flavourOf(n) === FLAVOURS[i]).length;

// A throw by the current player knocked over `fallenNums`. Updates the game (the winner, or a draw, when it ends)
// and whose turn it is; returns the message to show.
export function shakeThrow(game, fallenNums) {
  const s = game.shake, i = game.cur, mine = FLAVOURS[i];
  fallenNums = fallenNums.filter(n => !s.removed.includes(n));
  s.removed.push(...fallenNums);
  const own = fallenNums.filter(n => flavourOf(n) === mine).length, theirs = fallenNums.length - own;
  game.players.forEach((p, k) => { p.score = PER_FLAVOUR - leftFor(game, k); });
  s.throws++;
  s.log.push(game.players.map(p => p.score)); // both players' cleared counts after every throw (for the worm)
  const name = f => FLAVOUR_NAME[f].toLowerCase(), word = (n, f) => `${n} ${name(f)}`;
  let msg = !fallenNums.length ? 'Miss' : [own && word(own, mine), theirs && word(theirs, FLAVOURS[1 - i])].filter(Boolean).join(', ');
  if (theirs) msg += theirs === fallenNums.length ? ' (theirs!)' : '';
  // The end: a flavour cleared
  const mineLeft = leftFor(game, i), theirsLeft = leftFor(game, 1 - i);
  if (!mineLeft || !theirsLeft) {
    if (!mineLeft && !theirsLeft && !s.decisive) { game.draw = true; s.over = true; return `${msg}. Both flavours cleared: it's a draw!`; }
    game.winner = game.players[!mineLeft ? i : 1 - i]; s.over = true;
    const w = game.winner;
    return `${msg}. ${w.name} ${w.name === 'You' ? 'win' : 'wins'}!`;
  }
  if (mineLeft === 1 || theirsLeft === 1) s.squeeze = true;
  // Pool rules: a clean hit means another throw
  if (own && !theirs) { s.streak++; return `${msg}: throw again!`; }
  s.streak = 0;
  game.cur = 1 - i;
  if (s.squeeze) { s.squeezeNow = true; msg += '. The bottles move closer!'; }
  return msg;
}

// Where bottles go after a throw (poses: [{ t, q, num }] in bottle order; base: the classic plan of who needs
// standing up). Bottles knocked over go to their parking spot; when the turn has just passed in the squeeze, every
// bottle left comes closer. Returns [{ needs, x, z, gone }].
export function shakeRestand(poses, base, game) {
  const s = game.shake, removed = new Set(s.removed), squeeze = s.squeezeNow;
  s.squeezeNow = false;
  const plan = base.map((p, i) => {
    if (poses[i].num == null) return p;
    if (removed.has(poses[i].num)) return { needs: true, gone: true, ...parkSpot(i) };
    if (!squeeze) return p;
    const dx = p.x - RELEASE.x, dz = p.z - RELEASE.z, d = Math.hypot(dx, dz), nd = Math.max(NEAREST, d - SQUEEZE);
    return nd === d ? p : { needs: true, x: RELEASE.x + dx / d * nd, z: RELEASE.z + dz / d * nd };
  });
  // Bottles moved closer can meet: nudge them apart
  const live = plan.filter(p => !p.gone), min = 2 * BOTTLE_R + 0.006;
  for (let it = 0; it < 12; it++) {
    for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
      const A = live[a], B = live[b], d = Math.hypot(B.x - A.x, B.z - A.z);
      if (d >= min || (!A.needs && !B.needs)) continue;
      const nx = d > 1e-6 ? (B.x - A.x) / d : 1, nz = d > 1e-6 ? (B.z - A.z) / d : 0, m = B.needs ? B : A, sgn = m === B ? 1 : -1;
      m.x += sgn * nx * (min - d); m.z += sgn * nz * (min - d);
    }
  }
  return plan;
}
