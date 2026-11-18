// Two pigeons pecking about on the lawn beyond the bottles (an easter egg). If the stick or a bottle comes skidding
// up to them they take off and fly away, and drift back down a while later.
import * as THREE from 'three';

const HOMES = [[-1.3, -9.9, 0.6], [0.95, -10.3, -2.2]]; // x, z, which way they face (well past any bottle at rest)
const SCARE = 1.6, MOVING = 0.4; // something moving faster than this (m/s) within this far (m) scares them
const AWAY = [25, 45]; // seconds before they come back

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
const grey = mat(0x8e939b), dark = mat(0x5d636d), neck = mat(0x4f7a6a, { metalness: 0.3, roughness: 0.4 });
const pink = mat(0xc77b7b), black = mat(0x111111);
const sphere = new THREE.SphereGeometry(1, 12, 9);
const part = (m, sx, sy, sz, x, y, z, parent) => { const p = new THREE.Mesh(sphere, m); p.scale.set(sx, sy, sz); p.position.set(x, y, z); p.castShadow = true; parent.add(p); return p; };

// A pigeon about 30 cm long, facing +z, its feet at the group's origin
function pigeon() {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  part(grey, 0.075, 0.07, 0.12, 0, 0.11, 0, body);
  const tail = part(dark, 0.045, 0.012, 0.08, 0, 0.115, -0.15, body); tail.rotation.x = -0.25;
  const head = new THREE.Group(); head.position.set(0, 0.17, 0.09); body.add(head);
  part(neck, 0.05, 0.055, 0.05, 0, -0.02, -0.01, head);
  part(dark, 0.042, 0.042, 0.045, 0, 0.03, 0.02, head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.035, 6), dark); beak.rotation.x = Math.PI / 2; beak.position.set(0, 0.025, 0.075); head.add(beak);
  for (const s of [-1, 1]) part(black, 0.008, 0.008, 0.008, s * 0.03, 0.04, 0.045, head);
  // Wings hinge at the shoulders, folded along the body
  const wings = [-1, 1].map(s => {
    const w = new THREE.Group(); w.position.set(s * 0.06, 0.14, 0.01); body.add(w);
    part(dark, 0.075, 0.012, 0.07, s * 0.06, 0, -0.035, w);
    return w;
  });
  for (const s of [-1, 1]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.06, 5), pink); leg.position.set(s * 0.025, 0.03, 0.01); g.add(leg); }
  return { g, body, head, wings };
}

export function createPigeons(scene) {
  const birds = HOMES.map(([x, z, face], i) => {
    const p = pigeon(); p.wings[0].rotation.z = 1.25; p.wings[1].rotation.z = -1.25;
    p.g.position.set(x, 0, z); p.g.rotation.y = face;
    scene.add(p.g);
    return { ...p, home: new THREE.Vector3(x, 0, z), face, state: 'idle', t: i * 1.7, peck: 0, vel: new THREE.Vector3(), flap: 0, wait: 0 };
  });
  const last = new Map(); // where each thing was last frame (to see if it's moving)
  const v = new THREE.Vector3();

  function fold(b, k) { // wings: 0 folded down along its sides, else flapping (k: the phase)
    const a = k ? Math.sin(k) * 0.9 : 1.25;
    b.wings[0].rotation.z = a; b.wings[1].rotation.z = -a;
  }
  function scare(b, from) {
    if (b.state !== 'idle') return;
    b.state = 'flee'; b.t = 0;
    const away = b.g.position.clone().sub(from).setY(0);
    if (away.lengthSq() < 1e-4) away.set(Math.random() - 0.5, 0, -1);
    away.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.8);
    b.vel.copy(away).multiplyScalar(4.5).setY(3.2);
    b.g.rotation.y = Math.atan2(b.vel.x, b.vel.z);
  }

  // things: the stick and the bottles (Object3Ds); everything moving near a pigeon scares it (and its friend)
  function update(dt, things) {
    if (!dt) return;
    for (const o of things) {
      if (!o || !o.visible) continue;
      o.getWorldPosition(v);
      const was = last.get(o), speed = was ? was.distanceTo(v) / dt : 0;
      (was || last.set(o, new THREE.Vector3()).get(o)).copy(v);
      if (speed < MOVING || v.y > 2) continue;
      for (const b of birds) {
        if (b.state === 'idle' && Math.hypot(v.x - b.g.position.x, v.z - b.g.position.z) < SCARE) {
          scare(b, v);
          // Its friend goes a moment later
          for (const o2 of birds) if (o2 !== b && o2.state === 'idle' && o2.scareIn == null) { o2.scareIn = 0.12 + Math.random() * 0.25; o2.scareFrom = v.clone(); }
        }
      }
    }
    for (const b of birds) {
      b.t += dt;
      if (b.scareIn != null && (b.scareIn -= dt) <= 0) { scare(b, b.scareFrom); b.scareIn = null; }
      if (b.state === 'idle') {
        // Pecking: the head bobs down now and then, and every so often a little turn
        b.peck -= dt;
        if (b.peck < -0.25) b.peck = 0.6 + Math.random() * 2.2;
        const down = b.peck < 0 ? Math.sin((-b.peck / 0.25) * Math.PI) : 0;
        b.head.position.set(0, 0.17 - down * 0.07, 0.09 + down * 0.04); b.head.rotation.x = down * 0.9;
        if (Math.random() < dt * 0.15) b.g.rotation.y += (Math.random() - 0.5) * 1.2;
        b.body.position.y = 0; fold(b, 0);
      } else if (b.state === 'flee') {
        // Off, up and away, flapping hard, until it's out of the way
        b.vel.y += dt * 1.5;
        b.g.position.addScaledVector(b.vel, dt);
        b.flap += dt * 30; fold(b, b.flap);
        b.body.rotation.x = -0.35; b.head.rotation.x = 0;
        if (b.t > 6) { b.state = 'away'; b.g.visible = false; b.wait = AWAY[0] + Math.random() * (AWAY[1] - AWAY[0]); }
      } else if (b.state === 'away') {
        if ((b.wait -= dt) > 0) continue;
        // Come back: glide in from high up behind the pitch
        b.state = 'return'; b.t = 0; b.g.visible = true;
        b.from = b.home.clone().add(new THREE.Vector3((Math.random() - 0.5) * 20, 9, -18));
        b.g.rotation.y = Math.atan2(b.home.x - b.from.x, b.home.z - b.from.z);
      } else if (b.state === 'return') {
        const k = Math.min(1, b.t / 4), e = 1 - (1 - k) * (1 - k);
        b.g.position.lerpVectors(b.from, b.home, e);
        b.flap += dt * (k < 0.8 ? 12 : 26); fold(b, b.flap);
        b.body.rotation.x = -0.15 * (1 - k);
        if (k >= 1) { b.state = 'idle'; b.g.position.copy(b.home); b.g.rotation.y = b.face; b.body.rotation.x = 0; fold(b, 0); }
      }
    }
  }
  return { update };
}
