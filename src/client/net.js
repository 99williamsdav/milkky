// WebSocket connection to the game server. After a dropped connection or a page refresh it
// rejoins the same seat using the token from `joined`, kept per browser tab.
const SESSION_KEY = 'milkky-online';

// Same host as the page (nginx forwards /ws). For local testing: ?server=ws://localhost:8080/ws
export function serverUrl() {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }
export const hasSession = () => !!loadSession();

// onMessage(msg) for every server message; onStatus('open' | 'reconnecting' | 'failed' | 'closed')
export function createNet(onMessage, onStatus) {
  let ws = null, wanted = false, everOpened = false, retries = 0, timer = null, pending = null;

  function open() {
    clearTimeout(timer);
    ws = new WebSocket(serverUrl());
    ws.onopen = () => {
      const wasRetry = retries > 0; retries = 0; everOpened = true;
      const session = loadSession();
      // A fresh create/join takes priority; otherwise pick up where we left off.
      if (pending) { ws.send(JSON.stringify(pending)); pending = null; }
      else if (session) ws.send(JSON.stringify({ t: 'rejoin', code: session.code, token: session.token }));
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
    // Connect (if needed) and send `first`, e.g. a create or join message.
    start(first) {
      wanted = true;
      if (ws && ws.readyState === 1) return ws.send(JSON.stringify(first));
      pending = first;
      if (!ws) open();
    },
    // Reconnect to the seat saved in this tab, if any. Returns false if there's nothing to resume.
    resume() {
      if (!loadSession()) return false;
      wanted = true; if (!ws) open();
      return true;
    },
    send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); },
    leave() {
      wanted = false; clearTimeout(timer); clearSession(); pending = null;
      if (ws) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'leave' })); ws.close(); ws = null; }
    },
  };
}
