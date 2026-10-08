// The Milk King: a goofy 3D king getting drenched in milk, for whoever wins a league.
// Chunky, lumpy shapes in a bare purple room; drawn at full sharpness. It has a small renderer of its own,
// which only runs while it's on screen.
import * as THREE from 'three';

const ASPECT = 120 / 150;        // width / height of the picture
const CYCLE = 6;                 // seconds: pour, drench, drip, start again
const MILK = 0xfdfdf6;
const FONT_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/helvetiker_bold.typeface.json';
const MESSAGE = ['WELL DONE', 'YOU ARE THE', 'MILK KING!'];

let king = null; // the one that's running: { el, renderer, raf }

// Show the Milk King in `el` (or take it away)
export function showMilkKing(el, show) {
  if (!show) { if (king?.el === el) stop(); el.hidden = true; return; }
  el.hidden = false;
  if (king?.el === el) return;
  if (king) stop();
  start(el);
}

function stop() {
  cancelAnimationFrame(king.raf); king.sizer?.disconnect();
  king.renderer?.dispose(); king.renderer?.forceContextLoss();
  king.el.innerHTML = '';
  king = null;
}

// ---------- Materials ----------
// Faceted for things that are meant to look cut or folded (crown, robe, hair, floor); smooth for the rest.
const flat = (color, extra = {}) => new THREE.MeshPhongMaterial({ color, flatShading: true, shininess: 20, ...extra });
const smooth = (color, extra = {}) => new THREE.MeshPhongMaterial({ color, shininess: 30, ...extra });

// Push the vertices of a shape in and out a bit, the same amount wherever they meet, so it's lumpy but whole
function lumpy(geo, amount, seed = 1) {
  const p = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const h = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed) * 43758.5453;
    v.multiplyScalar(1 + (h - Math.floor(h) - 0.5) * amount);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function start(el) {
  el.innerHTML = `<canvas class="king-canvas" aria-hidden="true"></canvas>
    <p class="king-text">${MESSAGE.map(l => `<span>${l}</span>`).join('')}</p>`;
  const canvas = el.querySelector('canvas');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); }
  catch (e) { el.querySelector('canvas').remove(); return; } // no 3D here: the words alone will do
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  // Draw at the size it's shown (which changes between the wide and phone layouts)
  const fit = () => { const w = canvas.clientWidth; if (w) { renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(w, w / ASPECT, false); } };
  const sizer = new ResizeObserver(fit); sizer.observe(canvas); fit();
  king = { el, renderer, raf: 0, sizer };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x3a1a6e);
  scene.fog = new THREE.Fog(0x3a1a6e, 12, 22);
  const camera = new THREE.PerspectiveCamera(44, ASPECT, 0.1, 40);
  scene.add(new THREE.HemisphereLight(0xfff3d6, 0x5a2a8a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 5, 4); scene.add(sun);

  // A checkered floor behind him, for that bare-room-in-space feeling (kept short so it doesn't hide the words)
  const tiles = new THREE.Group();
  for (let i = -4; i <= 4; i++) for (let j = -3; j <= 0; j++) {
    const t = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), flat((i + j) & 1 ? 0xff4fa3 : 0x2bd1c0));
    t.rotation.x = -Math.PI / 2; t.position.set(i * 1.2, -2.25, j * 1.2); tiles.add(t);
  }
  scene.add(tiles);

  // ---------- The king ----------
  const robe = new THREE.Mesh(new THREE.ConeGeometry(1.35, 1.3, 7), flat(0x7d3c98));
  robe.position.y = -1.6; scene.add(robe);
  const head = new THREE.Group(); scene.add(head);
  const face = new THREE.Mesh(lumpy(new THREE.SphereGeometry(1.1, 28, 20), 0.1, 3), smooth(0xf0a878, { shininess: 15 }));
  face.scale.set(1, 1.12, 0.95); head.add(face);
  const eyeWhite = smooth(0xffffff, { shininess: 80 }), black = smooth(0x111111, { shininess: 90 });
  const eyes = [[-0.43, 0.28, 0.82, 0.42], [0.45, 0.34, 0.88, 0.27]].map(([x, y, z, r]) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), eyeWhite); e.position.set(x, y, z); head.add(e);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(r * 0.42, 14, 10), black);
    pupil.position.set(x, y, z + r * 0.8); head.add(pupil);
    return { pupil, x, y, z: z + r * 0.8, r };
  });
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), smooth(0xe8334a, { shininess: 70 })); nose.position.set(0.05, -0.05, 1.08); head.add(nose);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.36, 0.3), flat(0x5a0f14));
  mouth.position.set(0, -0.5, 0.92); mouth.rotation.z = 0.12; head.add(mouth);
  for (let k = 0; k < 5; k++) {
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.1), eyeWhite);
    tooth.position.set(-0.36 + k * 0.18, -0.39 + k * 0.022, 1.06); tooth.rotation.z = 0.12; head.add(tooth);
  }
  const tongue = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.42, 0.12), flat(0xff6f91));
  tongue.position.set(0.12, -0.78, 1.03); tongue.rotation.z = -0.2; head.add(tongue);
  // Wild hair, sticking out every which way
  const hairMat = flat(0xff7a1a);
  for (let k = 0; k < 9; k++) {
    const a = -1.3 + (k / 8) * 2.6 + (k % 2) * 0.15, side = Math.sign(Math.sin(a)) || 1;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.8, 4), hairMat);
    spike.position.set(Math.sin(a) * 1.05, Math.cos(a) * 0.95 - 0.1, -0.2);
    spike.rotation.z = -a + (k % 3 - 1) * 0.3; spike.rotation.x = side * 0.2;
    head.add(spike);
  }
  // A wonky crown
  const crown = new THREE.Group(); crown.position.set(0.05, 1.12, 0); crown.rotation.z = 0.22; head.add(crown);
  const gold = flat(0xffcc22, { side: THREE.DoubleSide });
  crown.add(new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.78, 0.38, 7, 1, true), gold));
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2, spike = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.48, 4), gold);
    spike.position.set(Math.sin(a) * 0.72, 0.42, Math.cos(a) * 0.72); crown.add(spike);
    if (k % 2 === 0) {
      const gem = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), flat([0xe8334a, 0x2f6fd0, 0x2e8b57][k % 3]));
      gem.position.set(Math.sin(a) * 0.79, 0, Math.cos(a) * 0.79); crown.add(gem);
    }
  }

  // ---------- The milk ----------
  const milkMat = smooth(MILK, { shininess: 90, specular: 0x777777 });
  // The bottle, tipped over him
  const bottle = new THREE.Group(); bottle.position.set(1.6, 2.55, 0.4); bottle.rotation.z = 2.35; scene.add(bottle);
  bottle.add(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 1.0, 7), flat(0xdfeef5)));
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 7), flat(0x2f6fd0)); band.position.y = -0.1; bottle.add(band);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.3, 0.4, 6), flat(0xdfeef5)); neck.position.y = 0.68; bottle.add(neck);
  const spout = new THREE.Vector3(0, 0.95, 0); // where the milk comes out, in the bottle's own space
  // The stream: blobs that fall from the bottle and land on his crown
  const BLOBS = 36, blobs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 10, 8), milkMat, BLOBS);
  blobs.frustumCulled = false; // its instances fly all over
  scene.add(blobs);
  const drops = Array.from({ length: BLOBS }, () => ({ p: new THREE.Vector3(0, -99, 0), v: new THREE.Vector3(), live: false }));
  // The gloop building up over his crown and head, the drips down his face, and the puddle
  const gloop = new THREE.Mesh(lumpy(new THREE.SphereGeometry(1, 24, 16), 0.22, 9), milkMat);
  gloop.position.set(0, 1.0, 0.05); head.add(gloop);
  const drips = [[-0.75, 0.55, 0.62, 1.3], [-0.2, 0.75, 0.98, 1.0], [0.4, 0.72, 0.95, 1.5], [0.82, 0.5, 0.55, 1.1], [0.1, 0.9, 0.7, 0.8]].map(([x, y, z, len]) => {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 1, 12), milkMat);
    d.geometry.translate(0, -0.5, 0); // grows downwards from the top
    d.position.set(x, y, z); head.add(d);
    return { d, len };
  });
  const puddle = new THREE.Mesh(lumpy(new THREE.CylinderGeometry(1, 1, 0.08, 24), 0.15, 5), milkMat);
  puddle.position.y = -2.2; scene.add(puddle);

  // ---------- The words, in 3D (the page shows them as plain text until the font arrives) ----------
  const words = new THREE.Group(); words.position.set(0, -2.8, 2.2); scene.add(words);
  loadWords(words, () => el.classList.add('has3d'));

  // ---------- Animation ----------
  const HIDDEN = new THREE.Vector3(0, -99, 0), m4 = new THREE.Matrix4(), spoutWorld = new THREE.Vector3(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const ease = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
  let last = performance.now(), emit = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const time = now / 1000, t = reduced ? 3.6 : time % CYCLE;
    // Bob, sway and stare
    head.rotation.set(Math.sin(time * 2.3) * 0.15, Math.sin(time * 1.7) * 0.45, Math.sin(time * 4.1) * 0.12);
    head.position.y = Math.abs(Math.sin(time * 5)) * 0.18;
    crown.rotation.z = 0.22 + Math.sin(time * 9) * 0.12;
    for (const e of eyes) e.pupil.position.set(e.x + (Math.random() - 0.5) * e.r * 0.5, e.y + (Math.random() - 0.5) * e.r * 0.5, e.z);
    camera.position.set(Math.sin(time * 0.6) * 1.4, 0.6, 11.4); camera.lookAt(0, -0.45, 0);
    // Pour: the bottle tips further, and blobs fly out and fall onto him
    bottle.rotation.z = 2.35 + Math.sin(time * 6) * 0.08 + ease(t, 0, 0.6) * 0.25;
    bottle.updateMatrixWorld(); spoutWorld.copy(spout).applyMatrix4(bottle.matrixWorld);
    emit += dt * (t > 0.4 && t < 3.8 ? 40 : 0);
    for (const d of drops) {
      if (!d.live && emit >= 1) {
        emit--; d.live = true; d.p.copy(spoutWorld);
        d.v.set(-2.2 + (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.5, (Math.random() - 0.5) * 0.4);
      }
      if (d.live) {
        d.v.y -= 9.8 * dt; d.p.addScaledVector(d.v, dt);
        if ((d.p.y < 1.9 + head.position.y && Math.abs(d.p.x) < 1) || d.p.y < -3) d.live = false; // splat into the gloop
      }
    }
    drops.forEach((d, i) => blobs.setMatrixAt(i, m4.compose(d.live ? d.p : HIDDEN, q, one)));
    blobs.instanceMatrix.needsUpdate = true;
    // Drench: gloop swells over his crown, drips run down his face, the puddle spreads; then it all starts again
    const wipe = 1 - ease(t, 5.3, 5.9);
    const g = ease(t, 0.7, 3.2) * wipe;
    gloop.scale.set(1.35 * g, 0.95 * g + 0.001, 1.25 * g); gloop.scale.y += Math.sin(time * 14) * 0.04 * g;
    drips.forEach((d, i) => { d.d.scale.set(1, Math.max(0.001, d.len * ease(t, 1.6 + i * 0.25, 3.8 + i * 0.3) * wipe), 1); });
    const s = ease(t, 2.4, 4.6) * wipe;
    puddle.scale.set(1.7 * s + 0.001, 1, 1.2 * s + 0.001);
    // The words bounce about
    words.children.forEach((w, i) => {
      w.rotation.y = Math.sin(time * 2 + i) * 0.35; w.rotation.z = Math.sin(time * 3.1 + i * 2) * 0.08;
      const pop = 1 + Math.abs(Math.sin(time * 4 + i * 0.8)) * 0.08; w.scale.set(pop, pop, pop);
    });

    if (el.offsetParent) renderer.render(scene, camera); // skip drawing while it's hidden
    king.raf = reduced ? 0 : requestAnimationFrame(frame);
  }
  king.raf = requestAnimationFrame(frame);
  if (reduced) setTimeout(() => el.isConnected && renderer.render(scene, camera), 500); // once more when the words arrive
}

// The message as chunky extruded letters, slightly bevelled
async function loadWords(group, done) {
  try {
    const [{ FontLoader }, { TextGeometry }] = await Promise.all([
      import('three/addons/loaders/FontLoader.js'), import('three/addons/geometries/TextGeometry.js'),
    ]);
    const font = await new FontLoader().loadAsync(FONT_URL);
    const faces = [flat(0xffe14a), flat(0xd35400)];
    MESSAGE.forEach((line, i) => {
      const geo = new TextGeometry(line, { font, size: i === 2 ? 0.62 : 0.46, height: 0.26, curveSegments: 6, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.02, bevelSegments: 2 });
      geo.center();
      const mesh = new THREE.Mesh(geo, i === 2 ? [flat(0x7fd4ff), flat(0x1f4e8c)] : faces);
      mesh.position.y = [0.7, 0.08, -0.62][i];
      group.add(mesh);
    });
    done();
  } catch (e) { /* the plain words stay */ }
}
