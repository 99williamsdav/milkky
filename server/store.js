// Saves rooms to disk so games survive restarts and deploys. One JSON file per room, written atomically
// (to a temporary file, then renamed) and batched so a burst of changes is written once.
// Where: MILKKY_DATA_DIR, else systemd's STATE_DIRECTORY, else server/data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.MILKKY_DATA_DIR || process.env.STATE_DIRECTORY || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const DIR = path.join(ROOT, 'rooms');
fs.mkdirSync(DIR, { recursive: true });

const file = code => path.join(DIR, `${code}.json`);
const pending = new Map(); // code → room waiting to be written
let timer = null;

export function save(room) {
  pending.set(room.code, room);
  if (!timer) timer = setTimeout(flush, 250);
}
export function flush() {
  clearTimeout(timer); timer = null;
  for (const [code, room] of pending) {
    try {
      const tmp = file(code) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(room.serialize()));
      fs.renameSync(tmp, file(code));
    } catch (err) { console.error('could not save room', code, err); }
  }
  pending.clear();
}
export function remove(code) {
  pending.delete(code);
  try { fs.unlinkSync(file(code)); } catch {}
}
// A room that broke: its save is kept to look at (CODE.json.bad) but never loaded again
export function quarantine(code) {
  pending.delete(code);
  try { fs.renameSync(file(code), file(code) + '.bad'); } catch {}
}
// Everything saved: [{ code, data }] (unreadable files are reported and set aside)
export function loadAll() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const code = f.slice(0, -'.json'.length);
    try { return { code, data: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }; }
    catch (err) { console.error('could not load', f, err.message); quarantine(code); return null; }
  }).filter(Boolean);
}
export const dataDir = ROOT;
