import { io } from 'socket.io-client';

// The duel connection (server/duel.js) and duel records (/api/duel/records). The server knows who you are from the
// Office Floor session cookie; nothing here sends an identity. Before each (re)connect the session is checked, which
// also refreshes an expired access cookie, because the socket handshake itself cannot refresh it.
// `duelLink.status`: 'connecting', 'online', 'retrying' or 'signed-out'.
const AVAILABLE_KEY = 'officeSim.duelAvailable';
const duelLink = { socket: null, status: 'connecting', retry: 0, timer: null, handlers: new Map(), onStatus: () => {} };

function savedAvailability() { try { return localStorage.getItem(AVAILABLE_KEY) !== 'off'; } catch (_) { return true; } }
function saveAvailability(on) { try { localStorage.setItem(AVAILABLE_KEY, on ? 'on' : 'off'); } catch (_) {} }

function setStatus(status) { if (duelLink.status !== status) { duelLink.status = status; duelLink.onStatus(status); } }

async function sessionOk() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) { window.dispatchEvent(new Event('office-auth-lost')); return false; }
    return res.ok;
  } catch (_) { return null; } // offline: try again later
}

// Connect once the scene is up. `onStatus(status)` hears about connection changes.
function connectDuel({ onStatus = () => {} } = {}) {
  duelLink.onStatus = onStatus;
  const socket = io({ path: '/api/socket.io', transports: ['websocket'], autoConnect: false, reconnection: false, auth: cb => cb({ available: savedAvailability() }) });
  duelLink.socket = socket;
  for (const [event, fns] of duelLink.handlers) for (const fn of fns) socket.on(event, fn);
  socket.on('connect', () => { duelLink.retry = 0; setStatus('online'); });
  // A dropped connection or a refused handshake: check the session (refreshing the cookie), then try again, backing off.
  const again = () => {
    if (!duelLink.socket) return;
    setStatus('retrying');
    clearTimeout(duelLink.timer);
    duelLink.timer = setTimeout(open, Math.min(30000, 1000 * 2 ** duelLink.retry++));
  };
  socket.on('connect_error', again);
  socket.on('disconnect', reason => { if (reason !== 'io client disconnect') again(); });
  open();
}
async function open() {
  const socket = duelLink.socket; if (!socket || socket.connected) return;
  setStatus(duelLink.retry ? 'retrying' : 'connecting');
  const ok = await sessionOk();
  if (duelLink.socket !== socket) return;
  if (ok === false) { setStatus('signed-out'); return; }
  if (ok === null) { clearTimeout(duelLink.timer); duelLink.timer = setTimeout(open, Math.min(30000, 1000 * 2 ** duelLink.retry++)); return; }
  socket.connect();
}
function disconnectDuel() {
  clearTimeout(duelLink.timer);
  duelLink.socket?.removeAllListeners(); duelLink.socket?.disconnect(); duelLink.socket = null;
  duelLink.handlers.clear(); duelLink.status = 'connecting';
}

// Listen for a server event (kept across reconnects).
function onDuel(event, fn) {
  if (!duelLink.handlers.has(event)) duelLink.handlers.set(event, []);
  duelLink.handlers.get(event).push(fn);
  duelLink.socket?.on(event, fn);
}
// Ask the server; resolves with its answer ({ ok, error? }), or a failure when offline or slow.
function askDuel(event, data) {
  const socket = duelLink.socket;
  if (!socket?.connected) return Promise.resolve({ ok: false, error: 'Duels are offline right now. Reconnecting…' });
  return new Promise(resolve => socket.timeout(6000).emit(event, data, (err, res) => resolve(err ? { ok: false, error: 'No answer from the server, try again' } : res ?? { ok: false })));
}
// Fire-and-forget (fight inputs and moves: the server's events are the answer). Not `volatile`: that drops a message
// whenever the connection is still writing the last one, which at 20 updates a second is most of them.
function sendDuel(event, data) { if (duelLink.socket?.connected) duelLink.socket.emit(event, data); }

function setAvailability(on) { saveAvailability(on); return askDuel('duel:available', { on }); }

// W–L–D for these user ids: { records: Map userId → { wins, losses, draws } } or { error, setup }.
async function fetchDuelRecords(ids) {
  if (!ids.length) return { records: new Map() };
  try {
    const res = await fetch(`/api/duel/records?ids=${ids.map(encodeURIComponent).join(',')}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) window.dispatchEvent(new Event('office-auth-lost'));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.error || 'Duel records are unavailable', setup: body.code === 'setup_required' };
    return { records: new Map(body.records.map(r => [r.userId, r])) };
  } catch (_) { return { error: 'Duel records are unavailable' }; }
}

export { askDuel, connectDuel, disconnectDuel, duelLink, fetchDuelRecords, onDuel, savedAvailability, sendDuel, setAvailability };
