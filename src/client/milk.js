// Milk spills: droplets from the neck and a spreading puddle on the grass. Purely visual.
import * as THREE from 'three';
import { BOTTLE_HALF, upY } from '../shared/constants.js';
import { scene } from './scene.js';
import { milkMat } from './models.js';

const dropGeo = new THREE.SphereGeometry(0.006, 6, 4);
const drops = Array.from({ length: 180 }, () => {
  const m = new THREE.Mesh(dropGeo, milkMat); m.visible = false; scene.add(m);
  return { m, v: new THREE.Vector3(), life: 0, ground: false };
});
const puddleGeo = new THREE.CircleGeometry(1, 28);
const puddleMat = new THREE.MeshStandardMaterial({ color: 0xfbfbf4, roughness: 0.2, transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
let emitters = [], puddles = [];
const upVec = new THREE.Vector3(), qTmp = new THREE.Quaternion();
function spill(p) {
  const t = p.body.translation(), r = p.body.rotation();
  upVec.set(0, 1, 0).applyQuaternion(qTmp.set(r.x, r.y, r.z, r.w));
  const dir = new THREE.Vector2(upVec.x, upVec.z); if (dir.lengthSq() < 1e-4) dir.set(0, -1); dir.normalize();
  // A puddle of three overlapping blobs, spreading out from the neck
  const g = new THREE.Group();
  g.position.set(t.x + upVec.x * (BOTTLE_HALF + 0.05), 0.009, t.z + upVec.z * (BOTTLE_HALF + 0.05));
  g.rotation.y = -Math.atan2(dir.y, dir.x);
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(puddleGeo, puddleMat.clone()); b.rotation.x = -Math.PI / 2;
    b.position.set((i - 1) * 0.05 + (Math.random() - 0.5) * 0.03, 0, (Math.random() - 0.5) * 0.05);
    b.userData.s = 0.06 + Math.random() * 0.05; b.scale.setScalar(0.001); g.add(b);
  }
  scene.add(g);
  const pud = { g, age: 0 }; puddles.push(pud);
  while (puddles.length > 40) removePuddle(puddles[0]);
  emitters.push({ p, t: 0 });
  p.spilled = true;
}
function removePuddle(pud) {
  scene.remove(pud.g); pud.g.children.forEach(b => b.material.dispose());
  puddles.splice(puddles.indexOf(pud), 1);
}
export function clearMilk(bottles) {
  [...puddles].forEach(removePuddle); emitters = [];
  drops.forEach(d => { d.life = 0; d.m.visible = false; });
  bottles.forEach(p => { p.spilled = false; p.milk.scale.y = 1; });
}
// spilling: whether bottles tipping over right now should start pouring
export function updateMilk(dt, bottles, spilling) {
  if (spilling) {
    for (const p of bottles) if (!p.spilled && upY(p.body.rotation()) < 0.35) spill(p);
  }
  for (const p of bottles) if (p.spilled && p.milk.scale.y > 0.3) p.milk.scale.y = Math.max(0.3, p.milk.scale.y - dt * 0.8);
  for (const e of emitters) {
    e.t += dt;
    if (e.t > 0.8) continue;
    const t = e.p.body.translation(), r = e.p.body.rotation(), lv = e.p.body.linvel();
    upVec.set(0, 1, 0).applyQuaternion(qTmp.set(r.x, r.y, r.z, r.w));
    for (let k = 0; k < 3; k++) {
      const d = drops.find(q => q.life <= 0); if (!d) break;
      d.life = 1.6; d.ground = false; d.m.visible = true; d.m.scale.setScalar(0.7 + Math.random() * 0.8);
      d.m.position.set(t.x + upVec.x * BOTTLE_HALF, t.y + upVec.y * BOTTLE_HALF, t.z + upVec.z * BOTTLE_HALF);
      d.v.set(upVec.x * 0.5 + (Math.random() - 0.5) * 0.3 + lv.x, 0.2 + Math.random() * 0.4 + lv.y * 0.5, upVec.z * 0.5 + (Math.random() - 0.5) * 0.3 + lv.z);
    }
  }
  emitters = emitters.filter(e => e.t <= 0.8);
  for (const d of drops) {
    if (d.life <= 0) continue;
    d.life -= dt;
    if (!d.ground) {
      d.v.y -= 9.81 * dt; d.m.position.addScaledVector(d.v, dt);
      if (d.m.position.y < 0.006) { d.m.position.y = 0.006; d.ground = true; d.m.scale.y *= 0.35; }
    }
    if (d.life < 0.4) d.m.scale.multiplyScalar(0.9);
    if (d.life <= 0) d.m.visible = false;
  }
  for (const pud of [...puddles]) {
    pud.age += dt;
    const grow = Math.min(1, pud.age / 1.4), ease = 1 - Math.pow(1 - grow, 3);
    for (const b of pud.g.children) {
      b.scale.setScalar(b.userData.s * ease + 0.001);
      if (pud.age > 30) b.material.opacity = Math.max(0, 0.92 * (1 - (pud.age - 30) / 4));
    }
    if (pud.age > 34) removePuddle(pud);
  }
}
