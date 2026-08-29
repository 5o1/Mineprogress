import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logError, resolveError, sanitizeErrorText, unresolvedErrors } from '../scripts/lib/errors.mjs';

async function temporaryData(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-errors-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('error messages are sanitized before append-only storage', () => {
  const fakeToken = `github${'_pat_'}${'a'.repeat(32)}`;
  const clean = sanitizeErrorText(`token: ${fakeToken} at C:\\Users\\Alice\\secret and alice@example.com https://github.com/alice/private/issues/1`);
  assert.doesNotMatch(clean, /github_pat_|Alice|alice@example/);
  assert.doesNotMatch(clean, /github\.com/);
  assert.match(clean, /REDACTED/);
});

test('status folds only unresolved events for its session', async t => {
  const dataDir = await temporaryData(t);
  const first = await logError(dataDir, { sessionId: 's1', stage: 'github', errorCode: 'GH_AUTH_INVALID', message: 'Denied' });
  await logError(dataDir, { sessionId: 's2', stage: 'github', errorCode: 'GH_NETWORK_ERROR', message: 'Offline' });
  assert.equal((await unresolvedErrors(dataDir, { sessionId: 's1' })).length, 1);
  await resolveError(dataDir, first.errorId, 'Token repaired');
  assert.deepEqual(await unresolvedErrors(dataDir, { sessionId: 's1' }), []);
  assert.equal((await unresolvedErrors(dataDir, { all: true })).length, 1);
});
