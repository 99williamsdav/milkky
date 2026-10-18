// Shared shots: replays people share by link (/replay?id=...). Each is a small JSON file in shots/ next to the rooms:
// { rec (the recording: see src/client/replay.js), label, who, when }. Watching one keeps it; shots nobody has
// watched for SHOT_TTL_DAYS are deleted. Recordings are checked for shape and size before they're kept.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { dataDir } from './store.js';

const env = (name, fallback) => (process.env[name] !== undefined ? +process.env[name] : fallback);
const DIR = path.join(dataDir, 'shots');
export const MAX_BYTES = 100_000;                         // a shot message (typical shots are 10–40 KB)
const TTL = env('MILKKY_SHOT_TTL_DAYS', 90) * 24 * 3600_000; // unwatched this long: deleted
const MAX_SHOTS = 20_000;
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // no I, O, 0 or 1
try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPose = p => Array.isArray(p) && p.length === 7 && p.every(isNum);
const text = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
// A recording as the game makes them: up to 48 bottles, up to 20 s of frames
function validRec(r) {
  if (!r || typeof r !== 'object' || !isNum(r.fps) || r.fps < 10 || r.fps > 120) return false;
  if (!Array.isArray(r.before) || !r.before.length || r.before.length > 48 || !r.before.every(isPose)) return false;
  if (!Array.isArray(r.bodies) || !r.bodies.length || r.bodies.length > 49 || !r.bodies.every(b => Number.isInteger(b) && b >= 0 && b <= r.before.length)) return false;
  if (!Array.isArray(r.frames) || r.frames.length < 2 || r.frames.length > r.fps * 20) return false;
  if (!r.frames.every(f => Array.isArray(f) && f.length === r.bodies.length * 7 && f.every(isNum))) return false;
  if (!Array.isArray(r.hidden || []) || !(r.hidden || []).every(Number.isInteger)) return false;
  return ['classic', 'battle', 'milkshake'].includes(r.variant || 'classic') && Number.isInteger(r.players ?? 2) && (r.players ?? 2) >= 1 && (r.players ?? 2) <= 4;
}
const file = id => path.join(DIR, `${id}.json`);
const validId = id => typeof id === 'string' && /^[A-Z2-9]{6}$/.test(id);

// Keep a shot; returns its id, or null if it isn't a proper recording (or there's no room left)
export function share({ rec, label, who } = {}) {
  if (!validRec(rec)) return null;
  try { if (fs.readdirSync(DIR).length >= MAX_SHOTS) return null; } catch { return null; }
  const shot = {
    rec: { v: 1, fps: rec.fps, before: rec.before, hidden: rec.hidden || [], bodies: rec.bodies, frames: rec.frames,
      variant: rec.variant || 'classic', players: rec.players ?? 2, when: isNum(rec.when) ? rec.when : Date.now() },
    label: text(label, 60) || 'A shot', who: text(who, 24), when: Date.now(),
  };
  for (let tries = 0; tries < 10; tries++) {
    const id = Array.from({ length: 6 }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join('');
    try { fs.writeFileSync(file(id), JSON.stringify(shot), { flag: 'wx' }); return id; } catch (err) { if (err.code !== 'EEXIST') return null; }
  }
  return null;
}
// A shared shot, or null (unknown or expired). Watching it counts as using it, so it's kept longer.
export function get(id) {
  if (!validId(id)) return null;
  try {
    const shot = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    const now = new Date(); fs.utimesSync(file(id), now, now);
    return shot;
  } catch { return null; }
}
// Delete shots nobody has watched for a long while
export function tidy() {
  const cutoff = Date.now() - TTL;
  try {
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch (err) { console.error('could not tidy shared shots', err.message); }
}
