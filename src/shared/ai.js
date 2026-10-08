// Computer players: target choice, throwing error, and the quick bot-vs-bot simulation.
import { RELEASE, AIM_LIMIT, MIN_DIST, MAX_DIST, clamp, homePositions } from './constants.js';
import { gauss } from './rng.js';

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

export function cpuChooseTarget(pl, info, target, samples = 80, rng = Math.random) {
  const need = target - pl.score, ai = pl.ai;
  const byNum = n => info.find(i => i.bottle.num === n);
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
