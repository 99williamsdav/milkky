// Game rules: players, scoring, turn order and re-standing fallen bottles.
// A game is a plain object: { players, cur, target, winner }.
import { BOTTLE_R, BOTTLE_HALF, COLORS, upY, upVector } from './constants.js';
import { LEVELS } from './ai.js';

export const MAX_MISSES = 3;
export const half = target => target / 2;
// "You hit" vs "Player 2 hits"
export const verb = (p, one, many) => p.name === 'You' ? many : one;

export function newPlayer(name, ai, color) {
  return { name, cpu: !!ai, ai, color, score: 0, misses: 0, out: false };
}

// types: ['human' | 'easy' | 'medium' | 'hard', ...]
export function createPlayers(types) {
  const humans = types.filter(t => t === 'human').length, cpus = types.length - humans;
  let h = 0, c = 0;
  return types.map((t, i) => {
    const cpu = t !== 'human';
    const lvl = cpu ? t[0].toUpperCase() + t.slice(1) : '';
    const name = cpu ? (cpus === 1 ? `Computer (${lvl})` : `CPU ${++c} (${lvl})`) : (humans === 1 ? 'You' : `Player ${++h}`);
    return newPlayer(name, cpu ? LEVELS[t] : null, COLORS[i]);
  });
}

// Apply a throw by the current player that knocked down the bottles numbered `fallenNums`.
// Updates scores, misses and the winner; returns the message to show.
export function scoreThrow(game, fallenNums) {
  const p = game.players[game.cur], target = game.target;
  let msg;
  if (fallenNums.length === 0) {
    p.misses++;
    if (p.misses >= MAX_MISSES) { p.out = true; msg = `Third miss. ${p.name} ${verb(p, 'is', 'are')} out.`; }
    else msg = `Miss (${p.misses} of ${MAX_MISSES})`;
  } else {
    const pts = fallenNums.length === 1 ? fallenNums[0] : fallenNums.length;
    p.misses = 0; p.score += pts;
    msg = fallenNums.length === 1 ? `Bottle ${fallenNums[0]}: +${pts}` : `${fallenNums.length} bottles: +${pts}`;
    if (p.score > target) { p.score = half(target); msg += `. Over ${target}, back to ${half(target)}`; }
    else if (p.score === target) { game.winner = p; msg = `${p.name} ${verb(p, 'hits', 'hit')} exactly ${target}!`; }
  }
  const left = game.players.filter(q => !q.out);
  if (!game.winner && game.players.length > 1 && left.length === 1) game.winner = left[0];
  return msg;
}

export const isGameOver = game => !!game.winner || game.players.every(q => q.out);

export function advanceTurn(game) {
  do { game.cur = (game.cur + 1) % game.players.length; } while (game.players[game.cur].out);
}

// Where each bottle stands after a throw. poses: [{ t: {x,y,z}, q: {x,y,z,w} }] in bottle order.
// Returns [{ needs, x, z }]: `needs` is true for bottles that must be stood up at (x, z).
export function planRestand(poses, rng = Math.random) {
  const items = poses.map(({ t, q }) => {
    const needs = upY(q) < 0.97 || t.y < BOTTLE_HALF - 0.006;
    if (!needs) return { needs, x: t.x, z: t.z };
    // Pivot up on the base: the flat bottom end stays where it lay.
    const u = upVector(q);
    return { needs, x: t.x - u.x * BOTTLE_HALF, z: t.z - u.z * BOTTLE_HALF };
  });
  // push re-stood bottles apart so none overlap
  const min = 2 * BOTTLE_R + 0.004;
  for (let it = 0; it < 30; it++) {
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (!A.needs && !B.needs) continue;
      let dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz);
      if (d >= min) continue;
      if (d < 1e-5) { dx = rng() - 0.5; dz = rng() - 0.5; d = Math.hypot(dx, dz); }
      const push = min - d, nx = dx / d, nz = dz / d;
      if (A.needs && B.needs) { A.x -= nx * push / 2; A.z -= nz * push / 2; B.x += nx * push / 2; B.z += nz * push / 2; }
      else if (A.needs) { A.x -= nx * push; A.z -= nz * push; }
      else { B.x += nx * push; B.z += nz * push; }
    }
  }
  return items;
}
