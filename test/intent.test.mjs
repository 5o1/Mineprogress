import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUserPrompt } from '../src/backend/lifecycle.mjs';
import { bindItem, openSession, readState, writeState } from '../src/backend/state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('user prompts remain journal evidence until background semantic review', async t => {
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

  for (const [index, prompt] of [
    '将会完成这个todo。',
    '接下来再测试一次任务完成，你先在上下文中提供所需的证据',
    '这个项目做完啦'
  ].entries()) {
    await handleUserPrompt({
      type: 'user-prompt', sessionId: 'session-intent', turnId: `turn-${index + 1}`,
      prompt, commandAction: null
    }, runtime);
  }
  const restored = await readState(dataDir, 'session-intent');
  assert.equal(restored.boundItems[0].statusIntent, null);
  assert.deepEqual(restored.journal.map(event => event.text), [
    '将会完成这个todo。',
    '接下来再测试一次任务完成，你先在上下文中提供所需的证据',
    '这个项目做完啦'
  ]);
});
