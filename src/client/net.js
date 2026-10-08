// WebSocket connection to the game server. After a dropped connection or a page refresh it
// rejoins the same seat using the token from `joined`, kept per browser tab.
// Each browser also has a long-lived player key, sent when creating or joining a room, so the server
// can find all your games (for "My games", and for coming back to games played at leisure).
const SESSION_KEY = 'milkky-online';
const PLAYER_KEY = 'milkky-me';

// Same host as the page (nginx forwards /ws). For local testing: ?server=ws://localhost:8080/ws
export function serverUrl() {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }
// Room code of the seat saved in this tab, if any
export const savedRoom = () => loadSession()?.code || null;

// ---------- Player key ----------
export function hasKey() { try { return !!localStorage.getItem(PLAYER_KEY); } catch (e) { return false; } }
export function myKey() {
  let k = null;
  try { k = localStorage.getItem(PLAYER_KEY); } catch (e) {}
  if (!k) {
    const b = crypto.getRandomValues(new Uint8Array(18));
    k = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
    try { localStorage.setItem(PLAYER_KEY, k); } catch (e) {}
  }
  return k;
}
export function setKey(k) { try { localStorage.setItem(PLAYER_KEY, k); } catch (e) {} }
export const validKey = k => typeof k === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(k);

// Your games across all rooms, over a short-lived connection of its own
export function fetchMine() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(serverUrl());
    const fail = err => { clearTimeout(timer); try { ws.close(); } catch (e) {} reject(err); };
    const timer = setTimeout(() => fail(new Error('timeout')), 8000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'mine', me: myKey() }));
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'mine') { clearTimeout(timer); ws.close(); resolve(m.games); }
    };
    ws.onerror = () => fail(new Error('unreachable'));
  });
}

// onMessage(msg) for every server message; onStatus('open' | 'reconnecting' | 'failed' | 'closed')
export function createNet(onMessage, onStatus) {
  let ws = null, wanted = false, everOpened = false, retries = 0, timer = null, pending = null;

  function open() {
    clearTimeout(timer);
    ws = new WebSocket(serverUrl());
    ws.onopen = () => {
      const wasRetry = retries > 0; retries = 0; everOpened = true;
      const session = loadSession();
      // A fresh create/join/rejoin takes priority; otherwise pick up where we left off.
      if (pending) { ws.send(JSON.stringify(pending)); pending = null; }
      else if (session) ws.send(JSON.stringify({ t: 'rejoin', code: session.code, token: session.token, me: myKey() }));
      onStatus(wasRetry ? 'reconnected' : 'open');
    };
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'joined') saveSession({ code: m.code, token: m.token });
      if (m.t === 'error' && m.code === 'gone') clearSession();
      onMessage(m);
    };
    ws.onclose = () => {
      ws = null;
      if (!wanted) return onStatus('closed');
      // Never reached the server and nothing to rejoin: report it rather than retrying forever.
      if (!everOpened && !loadSession()) { wanted = false; pending = null; return onStatus('failed'); }
      onStatus('reconnecting');
      timer = setTimeout(open, Math.min(8000, 500 * 2 ** retries++));
    };
  }

  return {
    // Connect (if needed) and send `first`: create, join, or rejoin (a room from "My games").
    // A live seat saved in this tab is sent along with a create/join, so the server frees it once the
    // new room has let us in (games played at leisure are kept: you can be in several).
    start(first) {
      wanted = true;
      first = { ...first, me: myKey() };
      const session = loadSession();
      if (session && first.t !== 'rejoin') first.leave = session;
      if (ws && ws.readyState === 1) return ws.send(JSON.stringify(first));
      pending = first;
      if (!ws) open();
    },
    // Reconnect to the seat saved in this tab, if any. Returns false if there's nothing to resume.
    resume() {
      const session = loadSession();
      if (!session) return false;
      wanted = true; pending = null;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'rejoin', code: session.code, token: session.token, me: myKey() }));
      else if (!ws) open();
      return true;
    },
    send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); },
    // Give up the seat (the computer plays it from now on, or it's freed in a lobby)
    leave() {
      wanted = false; clearTimeout(timer); pending = null;
      const inRoom = !!loadSession();
      clearSession();
      if (ws) { if (ws.readyState === 1 && inRoom) ws.send(JSON.stringify({ t: 'leave' })); ws.close(); ws = null; }
    },
    // Step away from a game played at leisure, keeping the seat
    detach() {
      wanted = false; clearTimeout(timer); pending = null; clearSession();
      if (ws) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'detach' })); ws.close(); ws = null; }
    },
  };
}
