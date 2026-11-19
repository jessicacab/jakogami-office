import assert from 'node:assert/strict';
import test from 'node:test';
import { assignedDesk } from '../config/desks.js';
import { seatFor } from './deskAssignment.js';

const jade = { name: 'Jade Malvin Cordero', userId: 'jade', department: null, desk: null };
const juna = { name: 'Juna', userId: 'juna', department: null, desk: 'B4' };
const seat = (deskId, extra = {}) => ({ deskId, owner: null, ...extra });

test('Keneth John Baguinat receives C1 using the roster spelling or Kenneth variant', () => {
  const own = seat('C1');
  for (const name of ['Keneth John Baguinat', 'Kenneth John Baguinat']) {
    assert.equal(assignedDesk(name), 'C1');
    assert.equal(seatFor({ name, userId: 'keneth', desk: null }, [own]), own);
  }
});

test('the special character keeps her existing high-chair desk', () => {
  const highChair = seat('A1');
  assert.equal(seatFor({ name: 'Hazel Sellote', desk: 'A1', spec: { special: 'hazel' } }, [highChair]), highChair);
});

test('real employees without a station are never randomly placed at any free desk', () => {
  const desks = [seat('B4'), seat('B5'), seat('extra')];
  assert.equal(seatFor(jade, desks, [jade]), null);
  assert.ok(desks.every(s => s.owner === null));
});

test('an explicitly assigned employee can still use their own unreserved station', () => {
  const own = seat('B5');
  assert.equal(seatFor({ ...jade, desk: 'B5' }, [seat('B4'), own], [jade]), own);
});

test('Juna owns B4 and Jade cannot take it when Juna is missing from the roster', () => {
  assert.equal(assignedDesk('Juna'), 'B4');
  const reserved = seat('B4'), free = seat('B5');
  assert.equal(seatFor(jade, [reserved, free], [jade]), null);
  assert.equal(reserved.owner, null);
});

test('a stale saved desk cannot place Jade in Juna’s reserved seat', () => {
  const reserved = seat('B4'), free = seat('B5');
  assert.equal(seatFor({ ...jade, desk: 'B4' }, [reserved, free], [jade]), null);
});

test('an absent named owner retains their desk regardless of allocation order', () => {
  const reserved = seat('B4'), free = seat('B5');
  assert.equal(seatFor(jade, [reserved, free], [jade, juna]), null);
  assert.equal(seatFor(juna, [reserved, free], [jade, juna]), reserved);
  assert.equal(reserved.owner, null, 'allocation does not spawn the absent owner');
});

test('named desk assignments override a mismatched fallback desk', () => {
  const reserved = seat('B4'), other = seat('B5');
  assert.equal(seatFor({ ...juna, desk: 'B5' }, [other, reserved]), reserved);
});

test('no spare desks means an unassigned person cannot displace a named owner', () => {
  assert.equal(seatFor(jade, [seat('B4')], [jade]), null);
  assert.equal(seatFor(juna, [seat('B4', { owner: jade }), seat('B5')]), null);
});

test('saved reservations and department-specific seating still apply', () => {
  const saved = seat('B5'), hr = seat('hr-1', { department: 'HR' }), general = seat('extra');
  const roster = [{ userId: 'other', desk: 'B5' }];
  assert.equal(seatFor(jade, [saved, hr, general], roster, { allowUnassigned: true }), general);
  assert.equal(seatFor({ ...jade, department: 'HR' }, [saved, hr, general], roster, { allowUnassigned: true }), hr);
});
