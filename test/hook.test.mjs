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

test('hooks create thread state and Stop blocks only for bound incremental work', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-hook-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const started = invoke('session-start', { session_id: 'session-1', source: 'startup' }, dataDir);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /created thread cache/);

  const prompt = invoke('user-prompt', { session_id: 'session-1', turn_id: 'turn-1', prompt: 'Implement parser tests.' }, dataDir);
  assert.equal(prompt.status, 0, prompt.stderr);
  const { state } = await openSession(dataDir, 'session-1');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  await writeState(dataDir, state);

  const stopped = invoke('stop', { session_id: 'session-1', turn_id: 'turn-1', last_assistant_message: 'Parser tests pass.', stop_hook_active: false }, dataDir);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).decision, 'block');
  assert.equal((await readState(dataDir, 'session-1')).activeUpdate.toSequence, 2);

  const guarded = invoke('stop', { session_id: 'session-1', turn_id: 'turn-1', last_assistant_message: 'Ignored', stop_hook_active: true }, dataDir);
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.equal(guarded.stdout, '');
});
