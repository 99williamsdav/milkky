// Milkkshake: a game for 2–4 players, each with a flavour of bottles (strawberry, blueberry, banana, chocolate, in seat
// order) in a shared rack (constants.js shakePositions: 12 each for 2 or 4 players, 9 each for 3). Anything knocked
// over leaves the game, whoever's it is; the first flavour to be cleared wins (so knocking over someone else's
// bottles helps them). Pool rules: after a clean hit (some of yours, nobody else's) you throw again; otherwise the turn
// passes to the next player. Once anyone is down to their last bottle, every bottle left moves SQUEEZE closer each
// time the turn passes (no nearer than NEAREST). If one throw clears several flavours, the thrower wins if theirs is
// among them (with two players, clearing both is a draw); otherwise it's a draw. Where a winner is needed (leagues,
// careers: `decisive`, always two players), the thrower wins.
//
// Each player's `score` is how much of their flavour has been cleared. Shared by the browser and the server:
// rules.js hands scoring, turns and re-standing over to these functions when a game has `shake` state.
import { RELEASE, BOTTLE_R, SHAKE_FLAVOURS, shakePositions } from './constants.js';
import { parkSpot } from './battle.js';

export const FLAVOURS = SHAKE_FLAVOURS;
export const MAX_PLAYERS = 4;
export const SQUEEZE = 0.5, NEAREST = 1.5;
export const flavourOf = num => FLAVOURS[Math.floor((num - 1) / 12)]; // numbered in blocks of 12 per flavour
export const FLAVOUR_NAME = { strawberry: 'Strawberry', blueberry: 'Blueberry', banana: 'Banana', chocolate: 'Chocolate' };

export function newShake(game, first = 0, { decisive = false } = {}) {
  const n = game.players.length;
  game.cur = first;
  game.shake = { removed: [], squeeze: false, squeezeNow: false, streak: 0, decisive, throws: 0, log: [],
    per: shakePositions(n).length / n }; // bottles of each flavour
  for (const p of game.players) p.score = 0;
  return game.shake;
}
export const flavourOfPlayer = i => FLAVOURS[i];
// How many of a player's flavour are left
export const leftFor = (game, i) => game.shake.per - game.shake.removed.filter(n => flavourOf(n) === FLAVOURS[i]).length;
const wins = p => `${p.name} ${p.name === 'You' ? 'win' : 'wins'}!`;

// A throw by the current player knocked over `fallenNums`. Updates the game (the winner, or a draw, when it ends)
// and whose turn it is; returns the message to show.
export function shakeThrow(game, fallenNums) {
  const s = game.shake, i = game.cur, mine = FLAVOURS[i], n = game.players.length;
  fallenNums = fallenNums.filter(num => !s.removed.includes(num));
  s.removed.push(...fallenNums);
  const own = fallenNums.filter(num => flavourOf(num) === mine).length, theirs = fallenNums.length - own;
  game.players.forEach((p, k) => { p.score = s.per - leftFor(game, k); });
  s.throws++;
  s.log.push(game.players.map(p => p.score)); // everyone's cleared count after every throw (for the worm)
  // "2 strawberry, 1 banana": the thrower's own first
  const counts = FLAVOURS.slice(0, n).map(f => [f, fallenNums.filter(num => flavourOf(num) === f).length])
    .filter(([, c]) => c).sort(([a], [b]) => (b === mine) - (a === mine));
  let msg = !fallenNums.length ? 'Miss' : counts.map(([f, c]) => `${c} ${FLAVOUR_NAME[f].toLowerCase()}`).join(', ');
  if (theirs && !own) msg += n === 2 ? ' (theirs!)' : ' (not yours!)';
  // The end: a flavour (or several) cleared
  const cleared = game.players.map((_, k) => k).filter(k => !leftFor(game, k));
  if (cleared.length) {
    s.over = true;
    if (cleared.length > 1 && !s.decisive && (n === 2 || !cleared.includes(i))) {
      game.draw = true;
      return `${msg}. ${n === 2 ? 'Both flavours' : `${cleared.length} flavours`} cleared at once: it's a draw!`;
    }
    game.winner = game.players[cleared.includes(i) ? i : cleared[0]];
    return `${msg}. ${wins(game.winner)}`;
  }
  if (game.players.some((_, k) => leftFor(game, k) === 1)) s.squeeze = true;
  // Pool rules: a clean hit means another throw
  if (own && !theirs) { s.streak++; return `${msg}: throw again!`; }
  s.streak = 0;
  game.cur = (i + 1) % n;
  if (s.squeeze) { s.squeezeNow = true; msg += '. The bottles move closer!'; }
  return msg;
}

// Where bottles go after a throw (poses: [{ t, q, num, active }] in bottle order; base: the classic plan of who needs
// standing up). Bottles knocked over go to their parking spot; when the turn has just passed in the squeeze, every
// bottle left comes closer. Bottles not in play (active: false) are left alone. Returns [{ needs, x, z, gone }].
export function shakeRestand(poses, base, game) {
  const s = game.shake, removed = new Set(s.removed), squeeze = s.squeezeNow;
  s.squeezeNow = false;
  const plan = base.map((p, i) => {
    if (poses[i].num == null || poses[i].active === false) return p;
    if (removed.has(poses[i].num)) return { needs: true, gone: true, ...parkSpot(i) };
    if (!squeeze) return p;
    const dx = p.x - RELEASE.x, dz = p.z - RELEASE.z, d = Math.hypot(dx, dz), nd = Math.max(NEAREST, d - SQUEEZE);
    return nd === d ? p : { needs: true, x: RELEASE.x + dx / d * nd, z: RELEASE.z + dz / d * nd };
  });
  // Bottles moved closer can meet: nudge them apart
  const live = plan.filter((p, i) => !p.gone && poses[i].active !== false), min = 2 * BOTTLE_R + 0.006;
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
