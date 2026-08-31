import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { unresolvedErrors } from '../src/backend/errors.mjs';
import { main, run } from '../src/frontends/codex/cli.mjs';

test('command failures after boolean flags are logged to the requested session', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-cli-error-'));
  const previousExitCode = process.exitCode;
  const originalError = console.error;
  try {
    console.error = () => {};
    await main(['unbind', 'PVTI_1', '--delete', '--session', 'session-x', '--data-dir', dataDir]);
    const errors = await unresolvedErrors(dataDir, { sessionId: 'session-x' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].errorCode, 'STATE_NOT_FOUND');
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Codex elevated retry flag preserves following values before backend parsing', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-cli-elevation-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const result = await run([
    'update', 'submit', '--elevated-retry', '--session', 'session-x', '--data-dir', dataDir
  ]);
  assert.equal(result.submitted, false);
  assert.equal(result.reason, 'Thread cache does not exist.');
});

test('Codex elevated retry flag is accepted for Project preparation', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-cli-prepare-elevation-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const result = await run([
    'update', 'prepare', '--elevated-retry', '--reconcile-bindings',
    '--session', 'session-x', '--data-dir', dataDir
  ]);
  assert.equal(result.outcome, 'noop');
});
