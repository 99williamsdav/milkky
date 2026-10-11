// Push notifications for games played at leisure: your turn, a round about to run out, a new season.
// Browsers subscribe (via the service worker, src/sw.js) and send us their subscription with their player key;
// we keep subscriptions by the key's hash (a player can have several devices) in push.json next to the rooms.
//
// Needs a VAPID key pair in the environment (generate once: npx web-push generate-vapid-keys):
//   MILKKY_VAPID_PUBLIC, MILKKY_VAPID_PRIVATE, and MILKKY_VAPID_SUBJECT (a mailto: or https: contact).
// Without them push is off, and clients don't offer it. For tests, MILKKY_PUSH_LOG=<file> writes each
// notification to that file (one JSON line each) instead of sending it.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { dataDir } from './store.js';

const PUBLIC = process.env.MILKKY_VAPID_PUBLIC || '', PRIVATE = process.env.MILKKY_VAPID_PRIVATE || '';
const LOG = process.env.MILKKY_PUSH_LOG || '';
export const enabled = !!LOG || !!(PUBLIC && PRIVATE);
export const publicKey = PUBLIC || (LOG ? 'test-key' : null);
if (PUBLIC && PRIVATE) webpush.setVapidDetails(process.env.MILKKY_VAPID_SUBJECT || 'mailto:milkky@example.com', PUBLIC, PRIVATE);

const FILE = path.join(dataDir, 'push.json');
const MAX_DEVICES = 5;
let subs = {}; // key hash → [subscription]
try { subs = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(subs)); fs.renameSync(FILE + '.tmp', FILE); }
    catch (err) { console.error('could not save push subscriptions', err.message); }
  }, 250);
}

// A subscription as the browser gives it: { endpoint (https), keys: { p256dh, auth } }
const valid = s => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
  && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string' && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
export function subscribe(me, s) {
  if (!enabled || !me || !valid(s)) return false;
  const list = (subs[me] || []).filter(x => x.endpoint !== s.endpoint);
  list.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
  subs[me] = list.slice(-MAX_DEVICES);
  save();
  return true;
}
export function unsubscribe(me, endpoint) {
  if (!me || !subs[me]) return;
  subs[me] = subs[me].filter(x => x.endpoint !== endpoint);
  if (!subs[me].length) delete subs[me];
  save();
}

// Send to every device of the player with key hash `me`: { title, body, room (code, opened when tapped) }.
// Devices that have gone (unsubscribed, or the browser was reset) are forgotten.
export function notify(me, { title, body, room }) {
  if (!enabled || !me || !subs[me]) return;
  const payload = { title, body, tag: room ? `milkky-${room}` : 'milkky', url: room ? `/?room=${room}` : '/' };
  for (const s of [...subs[me]]) {
    if (LOG) { fs.appendFileSync(LOG, JSON.stringify({ me, ...payload }) + '\n'); continue; }
    webpush.sendNotification(s, JSON.stringify(payload), { TTL: 24 * 3600, urgency: 'normal' })
      .catch(err => {
        if (err.statusCode === 404 || err.statusCode === 410) unsubscribe(me, s.endpoint);
        else console.error('push failed', err.statusCode || err.message);
      });
  }
}
export const hasDevices = me => !!subs[me]?.length;
