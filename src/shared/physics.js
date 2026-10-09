// The physics world: ground, bottles, stick and the grass friction model.
// Rapier is passed in so the browser can load it from a CDN and the server from npm.
import {
  BOTTLE_R, BOTTLE_HALF, STICK_R, STICK_HALF, DENSITY, RELEASE, ELEV, FALLEN_Y, homePositions,
} from './constants.js';

// Launch speed needed to travel `dist` metres and arrive at mid-bottle height, at the fixed release angle.
export function launchSpeedFor(dist) {
  const c = Math.cos(ELEV), drop = RELEASE.y - BOTTLE_HALF + dist * Math.tan(ELEV);
  return Math.min(12, Math.sqrt(9.81 * dist * dist / (2 * c * c * drop)));
}

// Grass drag: Rapier has no rolling resistance, so add damping only while a body lies on the grass.
const GRASS = { lin: 2.4, ang: 6.75 };
const BOTTLE_AIR = { lin: 0.3, ang: 0.8 }, STICK_AIR = { lin: 0.15, ang: 0.7 };
// Rolling resistance: a constant brake (not a percentage) on anything lying on the grass,
// so rolling comes to a definite stop instead of creeping on.
const ROLL = { ang: 45, lin: 1.4 }; // rad/s² of spin lost, m/s² of ground speed lost
const MAX_SUBSTEPS = 8;

const len = v => Math.hypot(v.x, v.y, v.z);

export function createPhysics(RAPIER) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 120;
  world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0).setFriction(0.8).setRestitution(0.1));

  const bottles = homePositions().map(({ num, x, z }) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, BOTTLE_HALF + 0.0005, z).setLinearDamping(0.3).setAngularDamping(0.8).setCanSleep(true));
    const collider = world.createCollider(RAPIER.ColliderDesc.cylinder(BOTTLE_HALF, BOTTLE_R).setDensity(DENSITY).setFriction(0.55).setRestitution(0.15), body);
    return { num, body, collider, homeX: x, homeZ: z };
  });

  let stick = null, stickCollider = null, acc = 0;
  // The first bottle the stick touched on this throw, and whether it was on its top: { num, top } (or null)
  let firstHit = null;

  function placeUpright(body, x, z) {
    body.setTranslation({ x, y: BOTTLE_HALF + 0.0005, z }, true);
    body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true); body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  function resetBottles() {
    for (const b of bottles) placeUpright(b.body, b.homeX, b.homeZ);
  }

  function throwStick(speed, aim) {
    const dir = { x: Math.sin(aim), y: 0, z: -Math.cos(aim) };
    const right = { x: -dir.z, y: 0, z: dir.x }; // dir × up (already unit length)
    const s = Math.sin(0.125), c = Math.cos(0.125); // upright, tipped slightly back (0.25 rad about `right`)
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(RELEASE.x, RELEASE.y, RELEASE.z).setRotation({ x: right.x * s, y: 0, z: right.z * s, w: c })
      .setLinearDamping(0.15).setAngularDamping(0.7).setCcdEnabled(true).setCanSleep(true));
    stickCollider = world.createCollider(RAPIER.ColliderDesc.cylinder(STICK_HALF, STICK_R).setDensity(DENSITY).setFriction(0.6).setRestitution(0.2), body);
    firstHit = null;
    const h = speed * Math.cos(ELEV);
    body.setLinvel({ x: dir.x * h, y: speed * Math.sin(ELEV), z: dir.z * h }, true);
    const spin = 5 + speed; // end-over-end tumble
    body.setAngvel({ x: right.x * spin, y: 0, z: right.z * spin }, true);
    stick = body;
    return body;
  }
  function removeStick() {
    if (stick) { world.removeRigidBody(stick); stick = null; stickCollider = null; }
  }

  function setDrag(body, grounded, air) {
    body.setLinearDamping(grounded ? GRASS.lin : air.lin);
    body.setAngularDamping(grounded ? GRASS.ang : air.ang);
  }
  function applyGrassDrag() {
    for (const b of bottles) setDrag(b.body, b.body.translation().y < BOTTLE_R + 0.015, BOTTLE_AIR);
    if (stick) setDrag(stick, stick.translation().y < STICK_R + 0.015, STICK_AIR);
  }
  function brake(body, dt) {
    const w = body.angvel(), ws = Math.hypot(w.x, w.y, w.z);
    if (ws > 0) { const k = Math.max(0, ws - ROLL.ang * dt) / ws; body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false); }
    const v = body.linvel(), vs = Math.hypot(v.x, v.z);
    if (vs > 0) { const k = Math.max(0, vs - ROLL.lin * dt) / vs; body.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, false); }
  }
  function rollingResistance(dt) {
    for (const b of bottles) if (!b.body.isSleeping() && b.body.translation().y < BOTTLE_R + 0.015) brake(b.body, dt);
    if (stick && !stick.isSleeping() && stick.translation().y < STICK_R + 0.015) brake(stick, dt);
  }

  // Advance by `dt` seconds of real time in fixed substeps.
  function advance(dt) {
    applyGrassDrag();
    acc += dt; let n = 0;
    while (acc >= world.timestep && n < MAX_SUBSTEPS) { rollingResistance(world.timestep); world.step(); noteFirstHit(); acc -= world.timestep; n++; }
    if (n === MAX_SUBSTEPS) acc = 0;
  }

  // Watch for the stick's first touch on a bottle. A touch on the top face, within the width of the
  // bottle's neck (in the bottle's own frame), counts as landing on its head; clipping the rim doesn't.
  function noteFirstHit() {
    if (!stickCollider || firstHit) return;
    world.contactPairsWith(stickCollider, other => {
      if (firstHit) return;
      const b = bottles.find(b => b.collider.handle === other.handle);
      if (!b) return;
      world.contactPair(stickCollider, other, (m, flipped) => {
        for (let k = 0; k < m.numContacts() && !firstHit; k++) {
          if (m.contactDist(k) > 0.002) continue;
          const p = flipped ? m.localContactPoint1(k) : m.localContactPoint2(k); // the point on the bottle
          firstHit = { num: b.num, top: p.y > BOTTLE_HALF - 0.003 && Math.hypot(p.x, p.z) < 0.018 };
        }
      });
    });
  }

  const allBodies = () => stick ? [...bottles.map(b => b.body), stick] : bottles.map(b => b.body);
  const isMoving = () => allBodies().some(b => !b.isSleeping() && (len(b.linvel()) > 0.03 || len(b.angvel()) > 0.4));
  const fallenBottles = () => bottles.filter(b => b.body.translation().y < FALLEN_Y);
  // [{ bottle, x, z }] for the computer players' target choice
  const bottleSpots = () => bottles.map(b => { const t = b.body.translation(); return { bottle: b, x: t.x, z: t.z }; });

  return {
    world, bottles,
    get stick() { return stick; },
    get firstHit() { return firstHit; },
    placeUpright, resetBottles, throwStick, removeStick, advance, isMoving, fallenBottles, bottleSpots,
  };
}
