import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCompletionDeclaration } from '../src/backend/intent.mjs';
import { handleUserPrompt } from '../src/backend/lifecycle.mjs';
import { bindItem, openSession, readState, writeState } from '../src/backend/state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('completion intent accepts assertions and rejects plans or conditions', () => {
  assert.equal(isCompletionDeclaration('项目结束了'), true);
  assert.equal(isCompletionDeclaration('当前任务已经完成'), true);
  assert.equal(isCompletionDeclaration('This project is complete.'), true);
  assert.equal(isCompletionDeclaration('将会完成这个todo。'), false);
  assert.equal(isCompletionDeclaration('接下来再测试一次任务完成，你先在上下文中提供所需的证据'), false);
  assert.equal(isCompletionDeclaration('任务完成情况需要进一步验证。'), false);
  assert.equal(isCompletionDeclaration('When the tests pass, the task will be complete.'), false);
  assert.equal(isCompletionDeclaration('How should we complete this project?'), false);
});

test('ordinary user completion assertion records one bound item status intent', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-intent-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { terminalStatuses: ['Done'], statusRoles: { completed: 'Done' } }
  }));
  const { state } = await openSession(dataDir, 'session-intent');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  await writeState(dataDir, state);
  const runtime = { dataDir, resourceRoot: root, environment: {}, githubClient: async () => null };

  await handleUserPrompt({
    type: 'user-prompt', sessionId: 'session-intent', turnId: 'turn-1',
    prompt: '将会完成这个todo。', commandAction: null
  }, runtime);
  assert.equal((await readState(dataDir, 'session-intent')).boundItems[0].statusIntent, null);

  await handleUserPrompt({
    type: 'user-prompt', sessionId: 'session-intent', turnId: 'turn-2',
    prompt: '项目结束了。', commandAction: null
  }, runtime);
  const restored = await readState(dataDir, 'session-intent');
  assert.equal(restored.boundItems[0].statusIntent.targetStatus, 'Done');
  assert.equal(restored.boundItems[0].statusIntent.sourceSequence, 2);
});
