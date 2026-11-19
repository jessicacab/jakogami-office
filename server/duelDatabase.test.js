import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Duel migration keeps results server-written and exposes only staff-visible totals', {
  skip: process.env.OFFICE_TEST_POSTGRES !== '1',
  timeout: 60000,
}, t => {
  // Explicit opt-in only. All roles/data are synthetic in a fresh private cluster.
  // Unix sockets only: no network listener and no connection to the user's databases.
  const root = mkdtempSync('/tmp/office-duel-pg-');
  let started = false;
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${command}: ${result.error || result.stderr || result.stdout}`);
  };
  t.after(() => {
    if (started) run('pg_ctl', ['-D', `${root}/data`, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  });
  run('initdb', ['-D', `${root}/data`, '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8']);
  run('pg_ctl', ['-D', `${root}/data`, '-l', `${root}/postgres.log`, '-o', `-F -k ${root} -c listen_addresses=''`, '-w', 'start']);
  started = true;
  run('psql', ['-X', '-h', root, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-f', fileURLToPath(new URL('../supabase/tests/duel_records.sql', import.meta.url))]);
});
