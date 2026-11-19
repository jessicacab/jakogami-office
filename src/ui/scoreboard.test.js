import assert from 'node:assert/strict';
import test from 'node:test';
import { rankRecords } from './scoreboardModel.js';

const emp = (userId, firstName, lastName) => ({ userId, firstName, lastName });
test('ranks by wins, then fewest losses, then draws, then name; only people who fought; short names', () => {
  const staff = [emp('a', 'Ana', 'Reyes'), emp('b', 'Ben', 'Cruz'), emp('c', 'Cara', 'Lim'), emp('d', 'Dan', 'Uy'), emp('e', 'Eve', 'Tan'), emp('f', 'Fay', '')];
  const records = new Map([
    ['a', { wins: 3, losses: 2, draws: 0 }], ['b', { wins: 3, losses: 1, draws: 0 }], ['c', { wins: 1, losses: 0, draws: 2 }],
    ['d', { wins: 0, losses: 0, draws: 0 }], ['f', { wins: 1, losses: 0, draws: 0 }],
  ]);
  assert.deepEqual(rankRecords(staff, records).map(r => r.name), ['Ben C.', 'Ana R.', 'Cara L.', 'Fay']);
});
