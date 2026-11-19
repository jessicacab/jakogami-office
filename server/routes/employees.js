import { Router } from 'express';
import { assignedDesk } from '../../src/config/desks.js';

// The internal tool's profile rows use `id` as the user id and `full_name` for the display name.
const splitName = name => {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts.shift() ?? '', lastName: parts.join(' ') };
};

function employeeRoutes(db) {
  const r = Router();

  r.get('/employees', async (req, res) => {
    const { data: rows, error } = await db.from('profiles')
      .select('id, full_name, role').eq('role', 'employee').order('full_name');
    if (error) throw error;
    res.json(rows.map(e => ({
      userId: e.id, ...splitName(e.full_name),
      photo: null, department: null, intern: false, shift: null,
      character: null,
      desk: assignedDesk(e.full_name),
    })));
  });

  return r;
}

export { employeeRoutes };
