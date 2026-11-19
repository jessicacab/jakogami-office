import { employeeById, fullName, jobTitle, roster } from '../people/roster.js';
import { fetchAttendanceSummary } from '../persistence/store.js';
import { people } from '../sim/state.js';
import { $ } from './dom.js';
import { select } from './person.js';

/* ================= Today's office roster ================= */
// The sidebar roster comes from calendar status, refreshed every two minutes.
const att = { data: null };
const REFRESH_MS = 120000;
let refreshTimer, active = false;

const dayLabel = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// One compact line per person: their name (hover for the department).
function row(userId) {
  const e = employeeById(userId); if (!e) return null;
  const p = people.find(q => q.userId === userId);
  const li = document.createElement('li'), b = document.createElement('button');
  b.type = 'button'; b.className = 'att-row'; b.title = `${fullName(e)} · ${jobTitle(e)}`;
  const n = document.createElement('span'); n.className = 'att-name'; n.textContent = fullName(e);
  b.append(n);
  if (p) b.onclick = () => select(p);
  li.append(b); return li;
}

function render() {
  const d = att.data;
  $('officeTodayN').textContent = d ? d.inOffice.length : '—';
  $('officeTodayDate').textContent = d ? dayLabel(d.today) : 'Loading today’s calendar…';
  if (!d) return;
  const rows = d.inOffice.map(id => row(id)).filter(Boolean).sort((a, b) => a.textContent.localeCompare(b.textContent));
  $('attList').replaceChildren(...rows);
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'office-empty';
    empty.textContent = 'No employees marked in office today.';
    $('attList').append(empty);
  }
}

async function refresh() {
  const d = await fetchAttendanceSummary();
  if (!active) return;
  if (d) { att.data = d; render(); }
  else {
    $('officeTodayDate').textContent = 'Today’s calendar status unavailable';
    $('officeTodayN').textContent = '—';
  }
}

function initAttendance() {
  active = true;
  render();
  if (!roster.list) {
    $('officeTodayDate').textContent = 'Employee roster unavailable';
    return;
  }
  refresh(); refreshTimer = setInterval(refresh, REFRESH_MS);
}

function stopAttendance() { active = false; clearInterval(refreshTimer); att.data = null; }

export { initAttendance, stopAttendance };
