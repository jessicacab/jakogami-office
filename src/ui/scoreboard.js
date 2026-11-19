import { roster } from '../people/roster.js';
import { fetchDuelRecords } from '../persistence/duel.js';
import { drawScoreboard } from '../world/furniture/scoreboard.js';
import { rankRecords } from './scoreboardModel.js';

// Keeps the duel scoreboard on the office wall (world/furniture/scoreboard.js) up to date: everyone on the staff
// list, ranked by wins, then fewest losses, then name; the top 5 are shown. Refreshed when the office opens, every
// minute, and a moment after any duel ends (ui/duel.js calls refreshScoreboard).
const REFRESH_MS = 60000;
const sb = { timer: null, pending: null, active: false };

async function refreshScoreboard() {
  if (!sb.active) return;
  const employees = roster.list ?? [], records = new Map();
  for (let i = 0; i < employees.length; i += 100) { // the records API takes at most 100 at a time
    const res = await fetchDuelRecords(employees.slice(i, i + 100).map(e => e.userId));
    if (!sb.active) return;
    if (res.error) { drawScoreboard([], res.setup ? 'Duel records need setup' : 'Duel records are unavailable right now'); return; }
    for (const [id, r] of res.records) records.set(id, r);
  }
  drawScoreboard(rankRecords(employees, records), '');
}
// After a duel ends, wait for the result to be saved first.
function scoreboardSoon(ms = 2500) { clearTimeout(sb.pending); sb.pending = setTimeout(refreshScoreboard, ms); }

function initScoreboard() {
  sb.active = true;
  refreshScoreboard();
  sb.timer = setInterval(refreshScoreboard, REFRESH_MS);
  document.fonts?.ready.then(() => drawScoreboard()); // redraw once the pixel font has loaded
}
function stopScoreboard() { sb.active = false; clearInterval(sb.timer); clearTimeout(sb.pending); }

export { initScoreboard, scoreboardSoon, stopScoreboard };
