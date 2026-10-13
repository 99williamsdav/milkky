// Computer players: target choice, throwing error, and the quick bot-vs-bot simulation.
import { RELEASE, AIM_LIMIT, MIN_DIST, MAX_DIST, clamp, homePositions, shakePositions } from './constants.js';
import { gauss } from './rng.js';
import { BATTLE_THROWS, BOTTLES, AREA, battleWinner } from './battle.js';

// Basic target choice plus human-like throwing error. No lookahead, no physics prediction.
export const LEVELS = {
  easy:   { aimSd: 0.055, distSd: 0.11, think: 'basic' },
  medium: { aimSd: 0.028, distSd: 0.06, think: 'risk' },
  hard:   { aimSd: 0.014, distSd: 0.035, think: 'risk' },
};
export function aiFromSkill(sk) {
  return { aimSd: 0.065 - sk * 0.053, distSd: 0.12 - sk * 0.088, think: sk < 0.3 ? 'basic' : 'risk' };
}

// list: [{ bottle: { num }, x, z }] → adds nearest-neighbour distance and bottles in the way
export function computeInfo(list) {
  return list.map(i => {
    let nearest = Infinity, blocked = 0;
    const lx = i.x - RELEASE.x, lz = i.z - RELEASE.z, L = Math.hypot(lx, lz);
    for (const o of list) {
      if (o === i) continue;
      nearest = Math.min(nearest, Math.hypot(o.x - i.x, o.z - i.z));
      const ox = o.x - RELEASE.x, oz = o.z - RELEASE.z, along = (ox * lx + oz * lz) / L;
      if (along > 0 && along < L - 0.05 && Math.abs(ox * lz - oz * lx) / L < 0.09) blocked++;
    }
    return { bottle: i.bottle, x: i.x, z: i.z, nearest, blocked };
  });
}

// The spot where a throw is least likely to miss: the middle of the biggest, nearest group of bottles.
// (Aiming between bottles in a group knocks something over more often than aiming at any one bottle.)
export function safestSpot(info) {
  let best = info[0], bestScore = -Infinity;
  for (const c of info) {
    const near = info.filter(o => Math.hypot(o.x - c.x, o.z - c.z) < 0.2); // includes c
    const around = info.filter(o => Math.hypot(o.x - c.x, o.z - c.z) < 0.32).length;
    const score = near.length * 2 + around - Math.hypot(c.x - RELEASE.x, c.z - RELEASE.z) * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = { ...c, x: near.reduce((s, o) => s + o.x, 0) / near.length, z: near.reduce((s, o) => s + o.z, 0) / near.length };
    }
  }
  return best;
}

export function cpuChooseTarget(pl, info, target, samples = 80, rng = Math.random) {
  const need = target - pl.score, ai = pl.ai;
  const byNum = n => info.find(i => i.bottle.num === n);
  // Last life: a miss means going out, so play safe whatever the score, and go for a big cluster.
  if (pl.misses >= 2) return safestSpot(info);
  if (ai.think === 'basic') {
    // Spots a winning bottle half the time; otherwise just throws at a random bottle.
    if (need <= 12 && rng() < 0.5) return byNum(need);
    return info[(rng() * info.length) | 0];
  }
  // Imagine throws at each bottle with our own accuracy and pick the best average outcome.
  const missCost = [3, 8, 60][Math.min(pl.misses, 2)]; // a miss on the last life knocks us out
  let best = info[0], bestU = -Infinity;
  for (const cand of info) {
    let u = 0;
    for (let k = 0; k < samples; k++) u += imagineThrow(cand, info, ai, pl, missCost, target, rng);
    u /= samples;
    if (u > bestU) { bestU = u; best = cand; }
  }
  return best;
}

// A rough model, not physics: the stick hits the first bottle near its path around where it comes down,
// and sometimes topples that bottle's close neighbours.
export function throwOutcome(cand, info, ai, rng = Math.random) {
  const dx = cand.x - RELEASE.x, dz = cand.z - RELEASE.z;
  const aim = Math.atan2(dx, -dz) + gauss(rng) * ai.aimSd;
  const d = Math.hypot(dx, dz) * (1 + gauss(rng) * ai.distSd);
  const ux = Math.sin(aim), uz = -Math.cos(aim);
  let hit = null, hitAlong = Infinity;
  for (const i of info) {
    const ox = i.x - RELEASE.x, oz = i.z - RELEASE.z;
    const along = ox * ux + oz * uz, side = Math.abs(ox * uz - oz * ux);
    if (side < 0.06 && along > d - 0.12 && along < d + 0.25 && along < hitAlong) { hit = i; hitAlong = along; }
  }
  if (!hit) return { hits: [], ux, uz };
  const hits = [hit];
  for (const i of info) if (i !== hit && Math.hypot(i.x - hit.x, i.z - hit.z) < 0.09 && rng() < 0.5) hits.push(i);
  return { hits, ux, uz };
}
function imagineThrow(cand, info, ai, pl, missCost, target, rng) {
  const { hits } = throwOutcome(cand, info, ai, rng);
  if (!hits.length) return -missCost;
  const pts = hits.length === 1 ? hits[0].bottle.num : hits.length, total = pl.score + pts;
  if (total === target) return 60;
  if (total > target) return target / 2 - pl.score; // drop back to half
  return pts;
}

// Pick a bottle and the (imperfect) throw the computer will actually make at it.
export function planCpuThrow(pl, info, target, rng = Math.random) {
  const tgt = cpuChooseTarget(pl, info, target, 80, rng), lvl = pl.ai;
  const dx = tgt.x - RELEASE.x, dz = tgt.z - RELEASE.z;
  const aim = clamp(Math.atan2(dx, -dz), -AIM_LIMIT, AIM_LIMIT);
  const dist = Math.hypot(dx, dz);
  const thrownAim = clamp(aim + gauss(rng) * lvl.aimSd, -AIM_LIMIT, AIM_LIMIT);
  const thrownDist = clamp(dist * (1 + gauss(rng) * lvl.distSd), MIN_DIST, MAX_DIST);
  return { aim, thrownAim, thrownDist, target: tgt.bottle.num };
}

// ---------- Quick simulation (bot vs bot league games) ----------
// Plays a whole game with the same decision-making and the same throw model, without the 3D physics.
export function simulateGame(A, B, first, target, rng = Math.random) {
  const field = homePositions().map(({ num, x, z }) => ({ bottle: { num }, x, z }));
  const ps = [A, B].map(e => ({ ai: e.ai, score: 0, misses: 0, out: false }));
  let t = first;
  for (let n = 0; n < 400; n++) {
    const p = ps[t];
    const info = computeInfo(field);
    const tgt = cpuChooseTarget(p, info, target, 30, rng);
    const { hits, ux, uz } = throwOutcome(tgt, info, p.ai, rng);
    if (!hits.length) {
      if (++p.misses >= 3) { p.out = true; return { winner: 1 - t, scores: ps.map(q => q.score) }; }
    } else {
      p.misses = 0;
      p.score += hits.length === 1 ? hits[0].bottle.num : hits.length;
      if (p.score > target) p.score = target / 2;
      // knocked bottles tumble forward and a little sideways, then are stood up where they land
      for (const h of hits) {
        const f = field.find(q => q.bottle.num === h.bottle.num), push = 0.1 + rng() * 0.5, side = gauss(rng) * 0.12;
        f.x += ux * push - uz * side; f.z += uz * push + ux * side;
      }
      if (p.score === target) return { winner: t, scores: ps.map(q => q.score) };
    }
    t = 1 - t;
  }
  return { winner: ps[0].score >= ps[1].score ? 0 : 1, scores: ps.map(q => q.score) };
}

// ---------- Battle (battle.js) ----------
// The attacker aims where it expects to take out the most bottles; the defender aims just past the tightest
// group, so the stick carries through and scatters it (the better defence in simulations). info: the bottles
// still in play (computeInfo). Returns the same as planCpuThrow.
function battleTarget(role, info, ai, rng) {
  if (role === 'defend') return { tgt: safestSpot(info), extra: 0.4 };
  const cands = [...info, safestSpot(info)];
  let tgt = cands[0], best = -1;
  for (const c of cands) {
    let u = 0;
    for (let k = 0; k < 40; k++) u += throwOutcome(c, info, ai, rng).hits.length;
    if (u > best) { best = u; tgt = c; }
  }
  return { tgt, extra: 0 };
}
export function planBattleThrow(pl, info, role, rng = Math.random) {
  const { tgt, extra } = battleTarget(role, info, pl.ai, rng), lvl = pl.ai;
  const dx = tgt.x - RELEASE.x, dz = tgt.z - RELEASE.z;
  const aim = clamp(Math.atan2(dx, -dz), -AIM_LIMIT, AIM_LIMIT);
  const thrownAim = clamp(aim + gauss(rng) * lvl.aimSd, -AIM_LIMIT, AIM_LIMIT);
  const thrownDist = clamp((Math.hypot(dx, dz) + extra) * (1 + gauss(rng) * lvl.distSd), MIN_DIST, MAX_DIST);
  return { aim, thrownAim, thrownDist, target: tgt.bottle.num };
}
// A whole battle between bots, without the physics (for careers' background games). Same shape as simulateGame:
// { winner, scores } (bottles cleared by each).
export function simulateBattle(A, B, first, rng = Math.random) {
  const ais = [A.ai, B.ai];
  const legs = [first, 1 - first].map(att => {
    let field = homePositions().map(({ num, x, z }) => ({ bottle: { num }, x, z }));
    const leg = { attacker: att, throws: 0, cleared: 0, log: [] };
    while (field.length && leg.throws < BATTLE_THROWS) {
      let info = computeInfo(field);
      const { hits } = throwOutcome(battleTarget('attack', info, ais[att], rng).tgt, info, ais[att], rng);
      field = field.filter(f => !hits.some(h => h.bottle.num === f.bottle.num));
      leg.throws++; leg.cleared = BOTTLES - field.length; leg.log.push(leg.cleared);
      if (!field.length) break;
      // The defender scatters what it hits, further than an ordinary throw moves them, within the area
      info = computeInfo(field);
      const d = throwOutcome(battleTarget('defend', info, ais[1 - att], rng).tgt, info, ais[1 - att], rng);
      for (const h of d.hits) {
        const f = field.find(q => q.bottle.num === h.bottle.num), push = 0.2 + rng() * 0.8, side = gauss(rng) * 0.3;
        f.x += d.ux * push - d.uz * side; f.z += d.uz * push + d.ux * side;
        const dx = f.x - RELEASE.x, dz = f.z - RELEASE.z;
        const r = clamp(Math.hypot(dx, dz), AREA.near, AREA.far), a = clamp(Math.atan2(dx, -dz), -AREA.side, AREA.side);
        f.x = RELEASE.x + Math.sin(a) * r; f.z = RELEASE.z - Math.cos(a) * r;
      }
    }
    return leg;
  });
  const w = battleWinner(legs), byPlayer = [0, 1].map(i => legs.find(l => l.attacker === i).cleared);
  return { winner: w, scores: byPlayer };
}

// ---------- Milkkshake (milkshake.js) ----------
// Aim where the expected result is best: your flavour knocked over minus theirs (each of theirs helps them), plus
// a little for a clean hit, which means another throw. info: the bottles in play (computeInfo), with flavours.
function shakeTarget(info, flavour, ai, rng) {
  let tgt = info[0], best = -Infinity;
  for (const c of info) {
    let u = 0;
    for (let k = 0; k < 40; k++) {
      const { hits } = throwOutcome(c, info, ai, rng);
      const own = hits.filter(h => h.bottle.flavour === flavour).length, theirs = hits.length - own;
      u += own - theirs + (own && !theirs ? 0.5 : 0);
    }
    if (u > best) { best = u; tgt = c; }
  }
  return tgt;
}
export function planShakeThrow(pl, info, flavour, rng = Math.random) {
  const tgt = shakeTarget(info, flavour, pl.ai, rng), lvl = pl.ai;
  const dx = tgt.x - RELEASE.x, dz = tgt.z - RELEASE.z;
  const aim = clamp(Math.atan2(dx, -dz), -AIM_LIMIT, AIM_LIMIT);
  return { aim, target: tgt.bottle.num,
    thrownAim: clamp(aim + gauss(rng) * lvl.aimSd, -AIM_LIMIT, AIM_LIMIT),
    thrownDist: clamp(Math.hypot(dx, dz) * (1 + gauss(rng) * lvl.distSd), MIN_DIST, MAX_DIST) };
}
// A whole Milkkshake between bots, without the physics (for careers' background games): { winner, scores }.
// A throw clearing both flavours goes to the thrower (careers need a winner).
export function simulateShake(A, B, first, rng = Math.random) {
  const ais = [A.ai, B.ai], flavours = ['strawberry', 'blueberry'];
  let field = shakePositions().map(({ num, x, z, flavour }) => ({ bottle: { num, flavour }, x, z }));
  const left = f => field.filter(q => q.bottle.flavour === f).length;
  let cur = first, squeeze = false;
  for (let n = 0; n < 300; n++) {
    const info = computeInfo(field), mine = flavours[cur];
    const { hits } = throwOutcome(shakeTarget(info, mine, ais[cur], rng), info, ais[cur], rng);
    field = field.filter(q => !hits.some(h => h.bottle.num === q.bottle.num));
    const own = hits.filter(h => h.bottle.flavour === mine).length, theirs = hits.length - own;
    if (!left(mine) || !left(flavours[1 - cur])) {
      const w = !left(mine) ? cur : 1 - cur;
      return { winner: w, scores: flavours.map(f => 12 - left(f)) };
    }
    if (left(mine) === 1 || left(flavours[1 - cur]) === 1) squeeze = true;
    if (own && !theirs) continue;
    cur = 1 - cur;
    if (squeeze) for (const q of field) {
      const dx = q.x - RELEASE.x, dz = q.z - RELEASE.z, d = Math.hypot(dx, dz), nd = Math.max(1.5, d - 0.5);
      q.x = RELEASE.x + dx / d * nd; q.z = RELEASE.z + dz / d * nd;
    }
  }
  const scores = flavours.map(f => 12 - left(f));
  return { winner: scores[0] >= scores[1] ? 0 : 1, scores };
}
