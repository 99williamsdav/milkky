// Push notifications for games played at leisure (your turn, a round about to run out, a new season).
// The service worker (src/sw.js) shows them; the game server sends them to every device subscribed with
// your player key. iPhones and iPads only allow them once Milkky has been added to the Home Screen.
import { ask, myKey } from './net.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let serverKey; // the server's public key (null: push is off there), asked for once

async function key() {
  if (serverKey === undefined) {
    try { serverKey = (await ask({ t: 'pushKey' }, 'pushKey')).key; } catch (e) { return null; } // ask again next time
  }
  return serverKey;
}
async function subscription() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

// 'on' | 'off' (can be turned on) | 'blocked' (refused in the browser) | 'homescreen' (iOS: add to Home Screen
// first) | 'unavailable' (no push in this browser, or the server doesn't do it)
export async function pushState() {
  if (!supported()) return isIOS() ? 'homescreen' : 'unavailable';
  if (!(await key())) return 'unavailable';
  if (Notification.permission === 'denied') return 'blocked';
  try { return Notification.permission === 'granted' && (await subscription()) ? 'on' : 'off'; } catch (e) { return 'off'; }
}

// Ask for permission (call straight from a tap), subscribe, and tell the server. Returns the new state.
export async function turnOn() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const k = await key();
  if (!k) return 'unavailable';
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64(k) });
  const r = await ask({ t: 'pushSubscribe', me: myKey(), sub: sub.toJSON() }, 'pushSubscribed');
  return r.ok ? 'on' : 'unavailable';
}
export async function turnOff() {
  const sub = await subscription();
  if (sub) {
    await ask({ t: 'pushUnsubscribe', me: myKey(), endpoint: sub.endpoint }, 'pushSubscribed').catch(() => {});
    await sub.unsubscribe();
  }
  return 'off';
}
// Already on: remind the server (it may have lost it, or this device's player key may have changed)
export async function refresh() {
  try {
    if (!supported() || Notification.permission !== 'granted') return;
    const sub = await subscription();
    if (sub) await ask({ t: 'pushSubscribe', me: myKey(), sub: sub.toJSON() }, 'pushSubscribed');
  } catch (e) {}
}

function fromBase64(s) {
  const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
