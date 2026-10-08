// Meshes for the bottles, stick, aim line and landing marker.
import * as THREE from 'three';
import { STICK_R, STICK_HALF } from '../shared/constants.js';
import { scene } from './scene.js';

function badgeTexture(n) {
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.92)'; g.beginPath(); g.roundRect(8, 14, 80, 68, 20); g.fill();
  g.fillStyle = '#1f2b23'; g.font = 'bold 52px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), 48, 50);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// ---------- Milk bottles (visual; the physics body is a plain cylinder) ----------
const glassMat = new THREE.MeshStandardMaterial({ color: 0xeef6f8, transparent: true, opacity: 0.3, roughness: 0.08, depthWrite: false });
export const milkMat = new THREE.MeshStandardMaterial({ color: 0xfdfdf6, roughness: 0.45 });
const capMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.85, roughness: 0.3 });
const lathe = pts => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 28);
const glassGeo = lathe([[0, -0.075], [0.025, -0.075], [0.029, -0.071], [0.029, 0.015], [0.026, 0.032], [0.019, 0.05], [0.0155, 0.062], [0.0155, 0.069], [0.0175, 0.071], [0.0175, 0.075], [0, 0.075]]);
const milkGeo = lathe([[0, 0], [0.026, 0], [0.027, 0.004], [0.027, 0.087], [0.024, 0.104], [0.019, 0.117], [0, 0.117]]);
const capGeo = new THREE.CylinderGeometry(0.0178, 0.0178, 0.006, 24);
const bandGeo = new THREE.CylinderGeometry(0.0294, 0.0294, 0.05, 28, 1, true);
function bottleLabel(n) {
  const c = document.createElement('canvas'); c.width = 384; c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = '#fbf6ea'; g.fillRect(0, 0, 384, 80);
  g.fillStyle = '#2f6fd0'; g.fillRect(0, 0, 384, 9); g.fillRect(0, 71, 384, 9);
  g.fillStyle = '#1d3f7a'; g.font = 'bold 50px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const x of [64, 192, 320]) { g.fillText(String(n), x, 42); if (n === 6 || n === 9) g.fillRect(x - 16, 62, 32, 4); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function makeBottle(num) {
  const model = new THREE.Group();
  const milk = new THREE.Mesh(milkGeo, milkMat); milk.position.y = -0.072; milk.castShadow = true; model.add(milk);
  const glass = new THREE.Mesh(glassGeo, glassMat); glass.renderOrder = 2; model.add(glass);
  const cap = new THREE.Mesh(capGeo, capMat); cap.position.y = 0.0755; cap.castShadow = true; model.add(cap);
  const band = new THREE.Mesh(bandGeo, new THREE.MeshStandardMaterial({ map: bottleLabel(num), roughness: 0.6 }));
  band.position.y = -0.028; band.castShadow = true; model.add(band);
  return { model, milk };
}

// Adds meshes to the physics bottles: { num, body } → { num, body, mesh, model, milk, spilled, label }
export function decorateBottles(bottles) {
  for (const p of bottles) {
    const mesh = new THREE.Group(); scene.add(mesh);
    const { model, milk } = makeBottle(p.num); mesh.add(model);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(p.num), depthWrite: false, transparent: true }));
    label.scale.set(0.09, 0.09, 1); scene.add(label);
    Object.assign(p, { mesh, model, milk, spilled: false, label });
  }
}

// ---------- Stick ----------
export const stickMesh = new THREE.Mesh(new THREE.CylinderGeometry(STICK_R, STICK_R, STICK_HALF * 2, 24),
  new THREE.MeshStandardMaterial({ color: 0xcfa264, roughness: 0.7 }));
stickMesh.castShadow = true;
export const hand = new THREE.Group(); scene.add(hand); hand.add(stickMesh);

// Aim line
export const aimGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
export const aimLine = new THREE.Line(aimGeo, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.75 }));
aimLine.visible = false; scene.add(aimLine);
// Marks where the stick first touched the grass on the last throw
export const landRing = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.095, 40),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
landRing.rotation.x = -Math.PI / 2; landRing.visible = false; scene.add(landRing);
