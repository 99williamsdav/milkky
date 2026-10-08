// Renderer, camera, lighting, lawn and the decorative park around it.
import * as THREE from 'three';

// ---------- Renderer & scene ----------
export const app = document.querySelector('#app');
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.prepend(renderer.domElement);
export const canvas = renderer.domElement;

export const scene = new THREE.Scene();
{ // soft summer sky: deeper blue overhead, hazy near the horizon
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#7fb6e0'); gr.addColorStop(0.55, '#b9d6ea'); gr.addColorStop(1, '#dde9ee');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; scene.background = t;
}
scene.fog = new THREE.Fog(0xd6e5ec, 18, 115);
export const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 260);

scene.add(new THREE.HemisphereLight(0xffffff, 0x4f6b33, 1.1));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
sun.position.set(2.5, 6, 0);
sun.target.position.set(0, 0, -3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 15 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
scene.add(sun, sun.target);

// Grass
{
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#5f9a3e'; g.fillRect(0, 0, 256, 256);
  const shades = ['#6aa845', '#548c36', '#77b351', '#4e8231', '#689f40'];
  for (let i = 0; i < 7000; i++) {
    g.fillStyle = shades[(Math.random() * shades.length) | 0];
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 1.5, 2 + Math.random() * 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(160, 160); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ map: t, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
}
// Throwing line (wooden plank)
{
  const plank = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.025, 0.06), new THREE.MeshStandardMaterial({ color: 0xb98d55, roughness: 0.8 }));
  plank.position.set(0, 0.0125, 0); plank.receiveShadow = plank.castShadow = true; scene.add(plank);
}

// ---------- Park scenery (decoration only, no physics) ----------
{
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; // fixed layout every visit
  const rr = (a, b) => a + rnd() * (b - a);
  const park = new THREE.Group(); scene.add(park);
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...extra });
  const blobGeo = new THREE.CircleGeometry(1, 24), blobMat = new THREE.MeshBasicMaterial({ color: 0x1d3a14, transparent: true, opacity: 0.22, depthWrite: false });
  const blob = (x, z, rad) => { const b = new THREE.Mesh(blobGeo, blobMat); b.rotation.x = -Math.PI / 2; b.position.set(x, 0.006, z); b.scale.setScalar(rad); park.add(b); };

  // Gravel path sweeping across behind the pitch
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-70, 0, -16), new THREE.Vector3(-30, 0, -11), new THREE.Vector3(-8, 0, -13.5), new THREE.Vector3(12, 0, -10.5), new THREE.Vector3(35, 0, -15), new THREE.Vector3(70, 0, -9)]);
  const pts = curve.getSpacedPoints(160), pos = [], idx = [];
  pts.forEach((pt, i) => {
    const tan = curve.getTangentAt(i / 160), nx = -tan.z, nz = tan.x;
    pos.push(pt.x + nx * 1.3, 0.008, pt.z + nz * 1.3, pt.x - nx * 1.3, 0.008, pt.z - nz * 1.3);
    if (i) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
  });
  const pathGeo = new THREE.BufferGeometry(); pathGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); pathGeo.setIndex(idx); pathGeo.computeVertexNormals();
  const path = new THREE.Mesh(pathGeo, mat(0xd9c8a0, { side: THREE.DoubleSide })); path.receiveShadow = true; park.add(path);

  // London plane trees: mottled trunks, lumpy canopies
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 9);
  const trunkMat = mat(0x8b8574), leafGeo = new THREE.IcosahedronGeometry(1, 1);
  const leafMats = [0x4f7d32, 0x5d8c3a, 0x46702c, 0x6a9a45].map(c => mat(c, { flatShading: true }));
  function tree(x, z, h) {
    const t = new THREE.Group(); t.position.set(x, 0, z);
    const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.scale.set(h / 9, h * 0.55, h / 9); trunk.position.y = h * 0.275; t.add(trunk);
    const n = 4 + (rnd() * 3 | 0);
    for (let i = 0; i < n; i++) {
      const leaf = new THREE.Mesh(leafGeo, leafMats[(rnd() * 4) | 0]);
      const sz = h * rr(0.22, 0.34);
      leaf.scale.set(sz, sz * rr(0.75, 0.95), sz);
      leaf.position.set(rr(-0.28, 0.28) * h, h * rr(0.62, 0.86), rr(-0.28, 0.28) * h);
      leaf.rotation.set(rnd() * 3, rnd() * 3, 0);
      t.add(leaf);
    }
    park.add(t); blob(x, z, h * 0.38);
  }
  const clearOfPitch = (x, z) => !(Math.abs(x) < 6 && z > -9 && z < 6);
  for (let i = 0; i < 70; i++) {
    const a = rr(-Math.PI * 0.95, Math.PI * 0.95) - Math.PI / 2, d = rr(14, 48);
    const x = Math.cos(a) * d, z = Math.sin(a) * d - 4;
    if (!clearOfPitch(x, z) || Math.abs(curve.getPoint(Math.min(1, Math.max(0, (x + 70) / 140))).z - z) < 2.5) continue;
    tree(x, z, rr(7, 13));
  }
  [[-9, -5], [10, -3], [-12, 3], [13, 6], [-7.5, -20], [8, -21]].forEach(([x, z]) => tree(x, z, rr(8, 11)));

  // Benches along the path, facing the pitch
  const green = mat(0x2f4a35, { roughness: 0.6 }), slat = mat(0x9a7046);
  function bench(x, z, rotY) {
    const b = new THREE.Group(); b.position.set(x, 0, z); b.rotation.y = rotY;
    for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.035, 0.12), slat); s.position.set(0, 0.45, -0.16 + i * 0.15); b.add(s); }
    for (let i = 0; i < 2; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.03), slat); s.position.set(0, 0.62 + i * 0.16, -0.27); s.rotation.x = -0.15; b.add(s); }
    for (const sx of [-0.78, 0.78]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.85, 0.5), green); l.position.set(sx, 0.42, -0.06); b.add(l); }
    b.traverse(m => { m.castShadow = true; }); park.add(b);
  }
  [-18, -6, 6, 19].forEach(x => { const pt = curve.getPoint((x + 70) / 140); bench(pt.x, pt.z + 2.0, 0); });

  // Victorian lamp posts
  const black = mat(0x1d1f1e, { roughness: 0.5 }), glass = mat(0xf3e7c4, { emissive: 0x6b5a2a, roughness: 0.3 });
  [-24, -12, 0, 12, 25].forEach(x => {
    const pt = curve.getPoint((x + 70) / 140), l = new THREE.Group(); l.position.set(pt.x, 0, pt.z - 1.7);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 3.6, 8), black); post.position.y = 1.8; l.add(post);
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.1, 0.4, 6), glass); lamp.position.y = 3.75; l.add(lamp);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.2, 6), black); cap.position.y = 4.05; l.add(cap);
    park.add(l);
  });

  // Flower beds
  const bedSoil = mat(0x5a4330), shrub = mat(0x3e6b2c, { flatShading: true });
  const flowerColors = [0xd8433b, 0xf2c94c, 0xa45fd1, 0xf7f3e8, 0xe9799a];
  const flowerGeo = new THREE.SphereGeometry(0.07, 6, 4);
  const flowers = new THREE.InstancedMesh(flowerGeo, mat(0xffffff), 600);
  let fi = 0; const m4 = new THREE.Matrix4(), col = new THREE.Color();
  [[-11, -16.5, 2.6], [9, -15, 2.2], [-16, -2, 1.8]].forEach(([x, z, rad]) => {
    const bed = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 0.08, 32), bedSoil); bed.position.set(x, 0.04, z); park.add(bed);
    const sh = new THREE.Mesh(leafGeo, shrub); sh.scale.set(0.6, 0.5, 0.6); sh.position.set(x, 0.3, z); park.add(sh);
    for (let k = 0; k < 190 && fi < 600; k++, fi++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * (rad - 0.15);
      m4.makeTranslation(x + Math.cos(a) * d, 0.12 + rnd() * 0.08, z + Math.sin(a) * d);
      flowers.setMatrixAt(fi, m4); flowers.setColorAt(fi, col.set(flowerColors[(rnd() * 5) | 0]));
    }
  });
  flowers.count = fi; park.add(flowers);

  // A couple of picnic blankets
  const gingham = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    g.fillStyle = '#f6f1e7'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(200,50,50,.55)'; for (let i = 0; i < 64; i += 16) { g.fillRect(i, 0, 8, 64); g.fillRect(0, i, 64, 8); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); return t;
  })();
  [[-8.5, -7, 0.4], [9.5, -6, -0.3]].forEach(([x, z, ry]) => {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.4), mat(0xffffff, { map: gingham })); b.rotation.set(-Math.PI / 2, 0, ry); b.position.set(x, 0.01, z); park.add(b);
    const basket = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.25, 0.3), mat(0xb88a4a)); basket.position.set(x + 0.4, 0.13, z - 0.2); basket.rotation.y = ry; basket.castShadow = true; park.add(basket);
  });

  // Distant city skyline: terraces, towers, a church spire and a dome, softened by haze
  const cityMats = [0x9aa7b3, 0xa9b2b8, 0x8e9aa6, 0xb3b0a7, 0x9c958a].map(c => mat(c));
  for (let x = -110; x < 110; x += rr(4, 9)) {
    const h = rnd() < 0.15 ? rr(25, 48) : rr(7, 18), w = rr(4, 9);
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, rr(5, 10)), cityMats[(rnd() * 5) | 0]);
    b.position.set(x, h / 2, rr(-88, -76)); park.add(b);
  }
  const spire = new THREE.Group(); spire.position.set(-34, 0, -72);
  { const tower = new THREE.Mesh(new THREE.BoxGeometry(4, 22, 4), cityMats[3]); tower.position.y = 11; spire.add(tower);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.6, 14, 4), cityMats[3]); cone.position.y = 29; cone.rotation.y = Math.PI / 4; spire.add(cone); }
  park.add(spire);
  const domeG = new THREE.Group(); domeG.position.set(28, 0, -80);
  { const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 16, 24), cityMats[1]); base.position.y = 8; domeG.add(base);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(7.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), cityMats[1]); dome.position.y = 16; domeG.add(dome);
    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.4, 5, 12), cityMats[1]); lantern.position.y = 25.5; domeG.add(lantern); }
  park.add(domeG);

  // Clouds
  const cloudTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d');
    for (let i = 0; i < 14; i++) {
      const x = 40 + rnd() * 176, y = 50 + rnd() * 40, rad = 20 + rnd() * 30;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 256, 128);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  for (let i = 0; i < 9; i++) {
    const cl = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, fog: false, transparent: true, opacity: rr(0.6, 0.9), depthWrite: false }));
    cl.position.set(rr(-150, 150), rr(35, 60), rr(-210, -150)); cl.scale.set(rr(50, 80), rr(18, 28), 1); park.add(cl);
  }
}
