// Runs a throw to completion on the server and records it for the clients to play back.
import { launchSpeedFor } from '../src/shared/physics.js';

export const SIM_DT = 1 / 60;
const FRAME_EVERY = 2; // record every other step: 30 fps playback
export const FPS = 1 / (SIM_DT * FRAME_EVERY);

const round = v => Math.round(v * 1e4) / 1e4;
// [x, y, z, qx, qy, qz, qw]
export function poseOf(body) {
  const t = body.translation(), r = body.rotation();
  return [t.x, t.y, t.z, r.x, r.y, r.z, r.w].map(round);
}
// One pose per bottle, in bottle order
export const snapshot = physics => physics.bottles.map(b => poseOf(b.body));

// Let things come to rest without recording (e.g. after bottles are stood back up).
export function settle(physics, seconds = 0.5) {
  for (let t = 0; t < seconds; t += SIM_DT) physics.advance(SIM_DT);
}

// Throw the stick and step until everything is still, using the same stopping rule as local play.
// Only bodies that move are sent: `bodies` lists them (bottle index, or 12 for the stick), and each
// frame is a flat array of 7 numbers per listed body, in that order. Other bottles stay where they were.
export function simulateThrow(physics, dist, aim) {
  physics.throwStick(launchSpeedFor(dist), aim);
  const frames = [];
  const record = () => {
    const f = [];
    for (const b of physics.bottles) f.push(...poseOf(b.body));
    if (physics.stick) f.push(...poseOf(physics.stick));
    frames.push(f);
  };
  record();
  let flyTime = 0, calm = 0, n = 0;
  for (;;) {
    physics.advance(SIM_DT); flyTime += SIM_DT; n++;
    calm = physics.isMoving() ? 0 : calm + SIM_DT;
    const done = (calm > 0.6 && flyTime > 0.8) || flyTime > 12;
    if (n % FRAME_EVERY === 0 || done) record();
    if (done) break;
  }
  const pose = (f, i) => f.slice(i * 7, i * 7 + 7);
  const STICK = physics.bottles.length, bodies = [];
  for (let i = 0; i <= STICK; i++) {
    const start = pose(frames[0], i);
    if (i === STICK || frames.some(f => pose(f, i).some((v, k) => Math.abs(v - start[k]) > 1e-4))) bodies.push(i);
  }
  return { bodies, frames: frames.map(f => bodies.flatMap(i => pose(f, i))), fps: FPS };
}
