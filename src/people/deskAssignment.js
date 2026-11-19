import { HAZEL_DESK, assignedDesk, reservedDeskIds } from '../config/desks.js';

// Permanent floor-plan assignments survive an absent or incomplete roster.
// Attendance controls whether someone appears, not who owns their desk.
function seatFor(who, seats, employees = [], { allowUnassigned = false } = {}) {
  const chosen = reservedDeskIds();
  for (const e of employees ?? []) if (e.desk && e.userId !== who.userId) chosen.add(e.desk);
  const assigned = who.spec?.special === 'hazel' ? HAZEL_DESK : assignedDesk(who.name);
  const desk = assigned ?? (chosen.has(who.desk) ? null : who.desk);
  if (desk) return seats.find(s => s.deskId === desk && !s.owner) ?? null;
  if (!allowUnassigned) return null;
  const open = s => !s.owner && !chosen.has(s.deskId);
  return seats.find(s => open(s) && s.department && s.department === who.department)
    ?? seats.find(s => open(s) && !s.department) ?? null;
}

export { seatFor };
