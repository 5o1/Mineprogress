import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendJournal,
  authorizeCommand,
  beginUpdate,
  bindItem,
  completeUpdate,
  controlCommandAction,
  isControlPrompt,
  openSession,
  pendingJournal,
  pruneStaleStates,
  readState,
  requireCommandAuthorization,
  retryExhaustedUpdate,
  statePath,
  unbindItem,
  writeState
} from '../scripts/lib/state.mjs';

async function temporaryData(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('thread state is isolated by hashed session id and restored', async t => {
  const dataDir = await temporaryData(t);
  const first = await openSession(dataDir, 'session/one');
  assert.equal(first.restored, false);
  assert.doesNotMatch(statePath(dataDir, 'session/one'), /session[\\/]one/);
  const second = await openSession(dataDir, 'session/one');
  assert.equal(second.restored, true);
});

test('binding is explicit and successful update advances incremental checkpoint', async t => {
  const dataDir = await temporaryData(t);
  const { state } = await openSession(dataDir, 's1');
  assert.equal(bindItem(state, { itemId: 'PVTI_1', title: 'Ship' }), true);
  assert.equal(bindItem(state, { itemId: 'PVTI_1', title: 'Ship' }), false);
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'Implemented the parser.' });
  appendJournal(state, { kind: 'assistant', turnId: 't1', text: 'Tests pass.' });
  const run = beginUpdate(state, 'run-1');
  assert.equal(run.toSequence, 2);
  completeUpdate(state, 'run-1');
  assert.deepEqual(pendingJournal(state), []);
  assert.equal(state.lastSuccessfulUpdate.sequence, 2);
  assert.equal(unbindItem(state, 'PVTI_1'), true);
  await writeState(dataDir, state);
  assert.deepEqual((await readState(dataDir, 's1')).boundItems, []);
});

test('mineprogress prompts are control events and are not journal content', () => {
  assert.equal(isControlPrompt('$mineprogress check'), true);
  assert.equal(isControlPrompt('please update the code'), false);
});

test('mutating commands consume explicit short-lived user authorization', () => {
  const state = newStateForTest();
  assert.equal(controlCommandAction('$mineprogress create "Task"'), 'create');
  assert.equal(authorizeCommand(state, 'create', 'turn-1'), true);
  const consume = requireCommandAuthorization(state, 'create');
  consume();
  assert.throws(() => requireCommandAuthorization(state, 'create'), { code: 'USER_AUTHORIZATION_REQUIRED' });
  assert.equal(controlCommandAction('Use Mineprogress to update retry'), 'update_retry');
});

test('new journal events do not replace an active recoverable transaction', () => {
  const state = { ...newStateForTest(), journal: [], nextSequence: 1 };
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'First change' });
  const first = beginUpdate(state, 'run-1');
  first.appliedOperations.push('PVTI_1:summary:key');
  appendJournal(state, { kind: 'user', turnId: 't2', text: 'Later change' });
  const resumed = beginUpdate(state, 'run-2');
  assert.equal(resumed.runId, 'run-1');
  assert.equal(resumed.toSequence, 1);
  assert.deepEqual(resumed.appliedOperations, ['PVTI_1:summary:key']);
  completeUpdate(state, 'run-1');
  assert.equal(pendingJournal(state).length, 1);
});

test('exhausted updates require an explicit retry', () => {
  const state = newStateForTest();
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'Change' });
  beginUpdate(state, 'run-1').exhausted = true;
  const retried = retryExhaustedUpdate(state);
  assert.notEqual(retried.runId, 'run-1');
  assert.equal(retried.fromSequence, 0);
});

test('stale ended thread state is pruned after retention period', async t => {
  const dataDir = await temporaryData(t);
  const { state } = await openSession(dataDir, 'old-session');
  state.lastEndedAt = '2025-01-01T00:00:00.000Z';
  await writeState(dataDir, state);
  const removed = await pruneStaleStates(dataDir, { retentionDays: 30, now: Date.parse('2026-01-01T00:00:00.000Z') });
  assert.equal(removed, 1);
  assert.equal(await readState(dataDir, 'old-session'), null);
});

function newStateForTest() {
  return {
    version: 1,
    sessionId: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEndedAt: null,
    boundItems: [],
    journal: [],
    controlTurnIds: [],
    nextSequence: 1,
    lastSuccessfulUpdate: null,
    activeUpdate: null
  };
}
