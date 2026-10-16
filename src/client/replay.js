// Shot replays: exact recordings of throws, which highlights to replay automatically, and saved shots.
// A recording is what the server sends for an online throw: the moving bodies' poses, 30 times a second
// (`bodies` lists them: bottle index, or the stick as the index after the bottles in play; each frame holds 7 numbers
// per listed body), plus where everything stood before the throw and which bottles were out of the game. Local
// throws are recorded the same way as they happen, so a replay is always exactly what was seen.
// rec: { v, fps, before: [pose per bottle in play], hidden: [bottle numbers], bodies, frames, variant, players, when }
const FPS = 30;
const round = v => Math.round(v * 1e4) / 1e4;
export const poseOf = body => { const t = body.translation(), r = body.rotation(); return [t.x, t.y, t.z, r.x, r.y, r.z, r.w].map(round); };
export const recordingLength = rec => (rec.frames.length - 1) / rec.fps;

// ---------- Recording a local throw ----------
// bottles: the physics bottles; active: how many are in play; hidden: numbers of any out of the game
export function startRecording(bottles, active, hidden, variant, players) {
  return { v: 1, fps: FPS, before: bottles.slice(0, active).map(b => poseOf(b.body)), hidden: [...hidden], variant, players,
    active, acc: 0, raw: [], when: Date.now() };
}
// Called every frame while the throw plays out (dt: seconds); keeps a frame every 1/30 s
export function sample(rec, bottles, stick, dt, force = false) {
  rec.acc += dt;
  if (!force && rec.raw.length && rec.acc < 1 / FPS) return;
  rec.acc = 0;
  const f = bottles.slice(0, rec.active).map(b => poseOf(b.body));
  f.push(stick ? poseOf(stick) : f[0].map(() => 0));
  rec.raw.push(f);
}
// The throw is over: keep only the bodies that moved (the stick always), as the server does
export function finishRecording(rec) {
  const raw = rec.raw, n = raw[0]?.length ?? 0, bodies = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1 || raw.some(f => f[i].some((v, k) => Math.abs(v - raw[0][i][k]) > 1e-4))) bodies.push(i);
  }
  const out = { v: rec.v, fps: rec.fps, before: rec.before, hidden: rec.hidden, variant: rec.variant, players: rec.players, when: rec.when,
    bodies, frames: raw.map(f => bodies.flatMap(i => f[i])) };
  return out;
}
// ---------- An online throw: the server's recording, with what we saw before it ----------
export function fromOnline(m, beforePoses, hidden, variant, players) {
  return { v: 1, fps: m.fps, before: beforePoses, hidden: [...hidden], variant, players, when: Date.now(), bodies: m.bodies, frames: m.frames };
}

// ---------- Highlights: shots worth an automatic slow-motion replay ----------
// t: { winner (the throw ended the game with a winner), variant ('classic' | 'battle' | 'milkshake'), fallen (bottle
// numbers, new ones only), role (Siege: 'attack' | 'defend'), own (Milkkshake: how many of the thrower's own),
// clean (Milkkshake: none of anyone else's), hit ({ num, top } | null), needle ({ gap } | null), single bottle's
// distance from the thrower (m) }. Returns a caption, or null.
export function highlightFor(t) {
  const n = t.fallen.length;
  if (t.winner) return 'Winning throw!';
  if (t.variant === 'battle') return t.role === 'attack' && n >= 5 ? `${n} in one throw!` : null;
  if (t.variant === 'milkshake') return t.clean && t.own >= 4 ? `${t.own} in one, all yours!` : null;
  if (n === 12) return 'Skittled! All 12!';
  if (n >= 7) return `${n} bottles in one throw!`;
  if (n === 1 && t.hit?.top && t.hit.num === t.fallen[0]) return 'Pinpoint, right on the cap!';
  if (n === 1 && t.distance > 6) return 'Long range!';
  if (!n && t.needle && t.needle.gap < 0.12) return 'Through the eye of the needle!';
  return null;
}

// ---------- Saved shots (on this device) ----------
const KEY = 'milkky-shots-v1', MAX_SHOTS = 40;
export function loadShots() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
// meta: { label, who } — returns false if it couldn't be saved (e.g. the browser's storage is full)
export function saveShot(rec, meta) {
  const shots = loadShots();
  if (shots.some(s => s.rec.when === rec.when && s.rec.frames.length === rec.frames.length)) return true; // already saved
  shots.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...meta, rec });
  try { localStorage.setItem(KEY, JSON.stringify(shots.slice(0, MAX_SHOTS))); return true; } catch (e) { return false; }
}
export function deleteShot(id) {
  try { localStorage.setItem(KEY, JSON.stringify(loadShots().filter(s => s.id !== id))); } catch (e) {}
}
