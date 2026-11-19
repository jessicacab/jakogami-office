// Saving and loading through our own API (server/), plus a copy of the player's look in this browser.
// The browser never talks to Supabase directly. Every call is safe to fail: storage can be blocked,
// and API failures never enable generated staff in the authenticated app.
const SPEC_KEY = 'officeSim.playerSpec';

const read = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch (_) {} };

function loadLocalSpec() { try { return JSON.parse(read(SPEC_KEY)); } catch (_) { return null; } }
function saveLocalSpec(spec) { write(SPEC_KEY, JSON.stringify(spec)); }

// Active employees: [{ userId, firstName, lastName, department, intern, character, desk }].
// Reject on failure so startup cannot substitute simulated employees.
async function fetchEmployees() {
  const res = await officeRequest('/api/employees', 6000);
  if (!res.ok) throw new Error('Employee roster unavailable');
  return res.json();
}
async function officeRequest(url, timeout) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401 || res.status === 403) window.dispatchEvent(new Event('office-auth-lost'));
  return res;
}
// Today's calendar presence: { today, records: [{ userId, status }] }, or null if unavailable.
async function fetchAttendance() {
  try {
    const res = await officeRequest('/api/attendance', 6000);
    return res.ok ? await res.json() : null;
  } catch (_) { return null; }
}
// Today's sidebar roster: { today, inOffice: [userId] }.
async function fetchAttendanceSummary() {
  try {
    const res = await officeRequest('/api/attendance/summary', 8000);
    return res.ok ? await res.json() : null;
  } catch (_) { return null; }
}
// Save your own character's look (server/routes/characters.js): { spec } as stored, or { error, setup }.
async function saveMyCharacter(spec) {
  try {
    const res = await fetch('/api/characters/me', {
      method: 'PUT', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec }), signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) window.dispatchEvent(new Event('office-auth-lost'));
    const body = await res.json().catch(() => ({}));
    return res.ok ? { spec: body.spec } : { error: body.error || 'Your character could not be saved right now.', setup: body.code === 'setup_required' };
  } catch (_) { return { error: 'Your character could not be saved. Check your connection and try again.' }; }
}

export { fetchAttendance, fetchAttendanceSummary, fetchEmployees, loadLocalSpec, saveLocalSpec, saveMyCharacter };
