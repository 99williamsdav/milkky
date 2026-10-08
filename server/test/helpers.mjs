// Shared bits for the end-to-end tests: start a real server, connect clients, count checks.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Each server gets its own empty data folder unless MILKKY_DATA_DIR is given (e.g. to restart onto saved rooms).
export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'milkky-test-'));
export async function startServer(port, env = {}) {
  const srv = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), MILKKY_ANIM_SCALE: '0', MILKKY_DATA_DIR: tempDir(), ...env }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => { srv.stdout.once('data', res); srv.once('exit', c => rej(new Error('server exited ' + c))); });
  return srv;
}
export const stopServer = srv => new Promise(res => { srv.once('exit', res); srv.kill(); });

// srv: the server process, or a function returning the current one (for tests that restart it)
export function checks(srv, timeoutMs = 120_000) {
  let failures = 0;
  const done = code => { (typeof srv === 'function' ? srv() : srv).kill(); process.exit(code); };
  setTimeout(() => { console.log('FAIL timed out'); done(1); }, timeoutMs).unref();
  return {
    check(ok, what) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; },
    finish() { console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed'); done(failures ? 1 : 0); },
  };
}

export const is = t => m => m.t === t;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// A WebSocket client that remembers messages until something asks for them
export function client(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = { name, ws, inbox: [], waiters: [], onMessage: null };
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (c.onMessage) c.onMessage(m);
    const w = c.waiters.findIndex(w => w.pred(m));
    if (w >= 0) c.waiters.splice(w, 1)[0].res(m); else c.inbox.push(m);
  });
  c.send = m => ws.send(JSON.stringify(m));
  // Resolve with the first message (already received or future) matching pred
  c.next = pred => {
    const i = c.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(c.inbox.splice(i, 1)[0]);
    return new Promise(res => c.waiters.push({ pred, res }));
  };
  c.open = new Promise(res => ws.once('open', res));
  return c;
}
