import { Router } from 'express';
import { officeDate } from '../../src/config/office.js';

async function calendarEntries(db, today) {
  const { data, error } = await db.from('calendar_entries')
    .select('user_id, status')
    .eq('date', today);
  if (error) throw error;
  return data;
}

function attendanceRoutes(db) {
  const r = Router();
  r.get('/attendance', async (req, res) => {
    const today = officeDate();
    const records = await calendarEntries(db, today);
    res.json({ today, records: records.map(entry => ({ userId: entry.user_id, status: entry.status })) });
  });
  // The sidebar lists active staff with an in_office calendar status for today.
  r.get('/attendance/summary', async (req, res) => {
    const today = officeDate();
    const [{ data: emps, error: empErr }, entries] = await Promise.all([
      db.from('profiles').select('id').eq('role', 'employee'),
      calendarEntries(db, today),
    ]);
    if (empErr) throw empErr;
    const active = new Set(emps.map(e => e.id));
    const inOffice = [...new Set(entries.filter(entry => entry.status === 'in_office' && active.has(entry.user_id)).map(entry => entry.user_id))];
    res.json({ today, inOffice });
  });

  return r;
}

export { attendanceRoutes };
