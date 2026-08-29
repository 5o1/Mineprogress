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
    env: { ...process.env, PLUGIN_DATA: dataDir, PLUGIN_ROOT: root }
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

test('hooks journal and Stop blocks only for bound incremental work', async t => {
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
  assert.equal(JSON.parse(stopped.stdout).decision, 'block');
  assert.equal((await readState(dataDir, 'session-1')).activeUpdate.toSequence, 2);

  const guarded = invoke('stop', { session_id: 'session-1', turn_id: 'turn-1', last_assistant_message: 'Ignored', stop_hook_active: true }, dataDir);
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.equal(guarded.stdout, '');
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
