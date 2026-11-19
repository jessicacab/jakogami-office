import { officeDate, officeMinutes } from '../config/office.js';
import { DAY_END, DAY_START } from './schedule.js';
import { addLog, people, sim } from './state.js';

/* ================= The clock and real attendance ================= */
// The office always follows the actual time in its time zone. When today's calendar
// attendance is available, only employees marked in_office are shown.
const live = { attendance: false, date: null, attDate: null, att: new Map() }; // att: userId → calendar status

// The office time on the sim clock: the sim day runs 06:00-06:00, so after midnight is 24:00 and up.
function liveMinutes(date = new Date()) { const m = officeMinutes(date); return m < DAY_START ? m + 24 * 60 : m; }
// The office date the current sim day started on (before 06:00 it still belongs to yesterday).
function liveDay(date = new Date()) { return officeDate(new Date(date.getTime() - DAY_START * 60000)); }

function setAttendance(records) {
  live.att = new Map(records.map(r => [r.userId, r.status]));
}
const isIn = status => status === 'in_office';

// Calendar entries contain a daily presence status, not clock times. In Live mode,
// the status determines presence for the office's simulated day.
function liveSchedule(p) {
  p.absent = !isIn(live.att.get(p.userId));
  if (p.absent) { p.arriveAt = Infinity; p.leaveAt = Infinity; return; }
  p.arriveAt = sim.t;
  p.leaveAt = DAY_END;
  p.arrivedAt = null;
}

// New calendar status from the server: employees marked in_office arrive, others leave.
function applyAttendance(data) {
  const before = live.att, changedDate = data.today !== live.attDate;
  setAttendance(data.records);
  live.attDate = data.today;
  if (!usesAttendance()) return;
  for (const p of people) {
    if (!p.userId) continue;
    const was = isIn(before.get(p.userId)), now = isIn(live.att.get(p.userId));
    if (now && (!was || changedDate)) { p.absent = false; p.arrivedAt = null; p.arriveAt = sim.t; p.leaveAt = DAY_END; }
    if (!now && was) {
      p.absent = true;
      p.leaveAt = sim.t;
      if (p.state === 'doing') p.until = sim.t; // finish up and head out
      addLog(`${p.name} is no longer marked in office`);
    }
  }
}

// Every frame: keep the sim clock on the office clock. Returns true when a new sim day started (06:00).
function tickLive() {
  sim.t = liveMinutes();
  const day = liveDay();
  if (day === live.date) return false;
  live.date = day; return true;
}

// Start the office at the current local time and apply today's attendance when available.
function initLive(attendance) {
  live.date = liveDay();
  live.attendance = !!attendance;
  live.attDate = attendance?.today ?? null;
  if (attendance) setAttendance(attendance.records);
  sim.t = liveMinutes(); sim.speed = 1; sim.paused = false;
}
// True when Live presence comes from today's calendar statuses.
function usesAttendance() { return live.attendance; }

export { applyAttendance, initLive, live, liveSchedule, tickLive, usesAttendance };
