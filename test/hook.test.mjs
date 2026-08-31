import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindItem, openSession, readState, writeState } from '../scripts/lib/state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hook = path.join(root, 'scripts', 'hook.mjs');

function invoke(mode, input, dataDir) {
  return spawnSync(process.execPath, [hook, mode], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: dataDir, PLUGIN_ROOT: root, MINEPROGRESS_DISABLE_BACKGROUND_UPDATE: '1' }
  });
}

async function markInitialized(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'config.json'), '{}\n');
}

test('idle hooks stay silent before initialization and do not create thread state', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const started = invoke('session-start', { session_id: 'session-1', source: 'startup' }, dataDir);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, '');

  const prompt = invoke('user-prompt', { session_id: 'session-1', turn_id: 'turn-1', prompt: 'Implement parser tests.' }, dataDir);
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.equal(prompt.stdout, '');
  const stopped = invoke('stop', { session_id: 'session-1', turn_id: 'turn-1', last_assistant_message: 'Parser tests pass.', stop_hook_active: false }, dataDir);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '');
  const ended = invoke('session-end', { session_id: 'session-1' }, dataDir);
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(ended.stdout, '');
  assert.equal(await readState(dataDir, 'session-1'), null);
});

test('explicit init supplies plugin data without creating thread state', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-init-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const submitted = invoke('user-prompt', {
    session_id: 'session-init',
    turn_id: 'turn-init',
    prompt: '$mineprogress:init'
  }, dataDir);
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext, /data_dir=/);
  assert.equal(await readState(dataDir, 'session-init'), null);
});

test('natural-language initialization request also supplies plugin data', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-natural-init-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const submitted = invoke('user-prompt', {
    session_id: 'session-init',
    turn_id: 'turn-init',
    prompt: 'Please initialize Mineprogress for this Project.'
  }, dataDir);
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext, /data_dir=/);
  assert.equal(await readState(dataDir, 'session-init'), null);
});

test('configured hooks stay silent until the thread has a bound item', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-empty-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await markInitialized(dataDir);
  for (const [mode, input] of [
    ['session-start', { session_id: 'session-empty' }],
    ['user-prompt', { session_id: 'session-empty', turn_id: 'turn-1', prompt: 'Ordinary work.' }],
    ['stop', { session_id: 'session-empty', turn_id: 'turn-1', last_assistant_message: 'Done.' }],
    ['session-end', { session_id: 'session-empty' }]
  ]) {
    const result = invoke(mode, input, dataDir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.equal(await readState(dataDir, 'session-empty'), null);
});

test('bound Stop journals without blocking the foreground conversation', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-bound-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await markInitialized(dataDir);
  const { state } = await openSession(dataDir, 'session-1');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  await writeState(dataDir, state);

  const started = invoke('session-start', { session_id: 'session-1', source: 'resume' }, dataDir);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /restored thread cache/);
  const prompt = invoke('user-prompt', { session_id: 'session-1', turn_id: 'turn-1', prompt: 'Implement parser tests.' }, dataDir);
  assert.equal(prompt.status, 0, prompt.stderr);

  const stopped = invoke('stop', { session_id: 'session-1', turn_id: 'turn-1', last_assistant_message: 'Parser tests pass.', stop_hook_active: false }, dataDir);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '');
  const stoppedState = await readState(dataDir, 'session-1');
  assert.equal(stoppedState.activeUpdate, null);
  assert.deepEqual(stoppedState.journal.map(event => event.text), ['Implement parser tests.', 'Parser tests pass.']);

  const guarded = invoke('stop', { session_id: 'session-1', turn_id: 'turn-1', last_assistant_message: 'Ignored', stop_hook_active: true }, dataDir);
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.equal(guarded.stdout, '');
});

test('binding schedules a full thread-history backfill without an earlier journal', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-pre-create-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await markInitialized(dataDir);
  invoke('user-prompt', { session_id: 'session-create', turn_id: 'turn-1', prompt: 'Earlier discussion before binding.' }, dataDir);
  assert.equal(await readState(dataDir, 'session-create'), null);
  const { state } = await openSession(dataDir, 'session-create');
  bindItem(state, { itemId: 'PVTI_1', title: 'Mineprogress' });
  await writeState(dataDir, state);
  const restored = await readState(dataDir, 'session-create');
  assert.deepEqual(restored.journal, []);
  assert.equal(restored.fullContextRequestedRevision, 1);
  assert.equal(restored.fullContextPlannedRevision, 0);
});

test('Stop does not revise a plan while an earlier submission is unverified', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-unverified-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await markInitialized(dataDir);
  const { state } = await openSession(dataDir, 'session-unverified');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  state.pendingPlan = {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'Pending.' }] },
    projectId: 'PVT_1',
    operations: [{ key: 'operation-1', itemId: 'PVTI_1', kind: 'summary', before: null, expected: 'Pending.', fieldId: 'UPDATE', value: { text: 'Pending.' } }],
    throughSequence: 1,
    submissionStatus: 'unverified',
    attempts: [{ attemptId: 'attempt-1', operationKeys: ['operation-1'], startedAt: new Date().toISOString(), responseReceivedAt: null }]
  };
  await writeState(dataDir, state);
  invoke('user-prompt', { session_id: 'session-unverified', turn_id: 'turn-2', prompt: 'More work.' }, dataDir);
  const stopped = invoke('stop', { session_id: 'session-unverified', turn_id: 'turn-2', last_assistant_message: 'More done.' }, dataDir);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '');
  const restored = await readState(dataDir, 'session-unverified');
  assert.equal(restored.activeUpdate, null);
  assert.equal(restored.pendingPlan.attempts.length, 1);
  assert.equal(restored.journal.length, 2);
});

test('UserPromptSubmit resumes an interrupted elevated submission through the active agent', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-elevation-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await markInitialized(dataDir);
  const { state } = await openSession(dataDir, 'session-elevation');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  state.pendingPlan = {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'Pending.' }] },
    projectId: 'PVT_1',
    operations: [{ key: 'operation-1', itemId: 'PVTI_1', kind: 'summary' }],
    throughSequence: 1,
    submissionStatus: 'ready',
    attempts: [],
    submissionBlock: {
      kind: 'sandbox-elevation', status: 'in_progress', errorId: 'sandbox-error-1', requestedAt: new Date().toISOString(),
      attemptCount: 1, logged: true
    }
  };
  await writeState(dataDir, state);

  const submitted = invoke('user-prompt', {
    session_id: 'session-elevation', turn_id: 'turn-elevation', prompt: 'Continue ordinary work.'
  }, dataDir);
  assert.equal(submitted.status, 0, submitted.stderr);
  const context = JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /durable reviewed GitHub submission awaiting sandbox elevation/);
  assert.match(context, /update submit --elevated-retry/);
  assert.match(context, /--session "session-elevation"/);
  assert.match(context, /--data-dir/);
});

test('UserPromptSubmit records authorization for an explicit mutating command', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-auth-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await markInitialized(dataDir);
  const submitted = invoke('user-prompt', {
    session_id: 'session-auth',
    turn_id: 'turn-auth',
    prompt: '$mineprogress:bind PVTI_1'
  }, dataDir);
  assert.equal(submitted.status, 0, submitted.stderr);
  const hookContext = JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext;
  assert.equal(hookContext.includes(`data_dir=${dataDir}`), true);
  const state = await readState(dataDir, 'session-auth');
  assert.deepEqual(state.pendingAuthorizations.map(entry => entry.action), ['bind']);
  assert.equal(state.journal.length, 0);
});
