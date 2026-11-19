import { fullName } from '../people/roster.js';

// The scoreboard's ranking (ui/scoreboard.js), kept free of the 3D scene so it can be tested on its own:
// everyone who has fought at least once, by wins, then fewest losses, then most draws, then name.
const shortName = e => { const n = fullName(e).trim().split(/\s+/); return n.length > 1 ? `${n[0]} ${n.at(-1)[0]}.` : n[0] || 'Someone'; };

function rankRecords(employees, records) {
  return employees
    .map(e => ({ name: shortName(e), ...(records.get(e.userId) ?? { wins: 0, losses: 0, draws: 0 }) }))
    .filter(r => r.wins + r.losses + r.draws > 0)
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.draws - a.draws || a.name.localeCompare(b.name));
}

export { rankRecords };
