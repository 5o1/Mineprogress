import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../scripts/mineprogress.mjs';
import { createConfig, saveConfig } from '../scripts/lib/config.mjs';
import { authorizeCommand, bindItem, openSession, readState, writeState } from '../scripts/lib/state.mjs';
import { statusFixture } from './status-fixture.mjs';

test('explicit unbind deletion closes an Issue before deleting its Project item', async t => {
  const statuses = statusFixture();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-delete-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await saveConfig(path.join(dataDir, 'config.json'), createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { defaultStatus: statuses.queued, terminalStatuses: [statuses.terminal] }
  }));
  const { state } = await openSession(dataDir, 'session-1');
  bindItem(state, {
    itemId: 'PVTI_1', title: 'Task', contentId: 'I_1', contentType: 'issue',
    url: 'https://example.test/1', repository: 'octocat/todos'
  });
  authorizeCommand(state, 'unbind', 'turn-1');
  await writeState(dataDir, state);

  const previousToken = process.env.GITHUB_TOKEN;
  const previousDisableGh = process.env.MINEPROGRESS_DISABLE_GH_AUTH;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.MINEPROGRESS_DISABLE_GH_AUTH = '1';
  const mutations = [];
  globalThis.fetch = async (_url, request) => {
    const { query } = JSON.parse(request.body);
    let data;
    if (query.includes('query($login')) {
      data = { user: { projectV2: {
        id: 'PVT_1', title: 'Tasks', public: false,
        repositories: { totalCount: 0, nodes: [] },
        fields: { nodes: [] },
        items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
          id: 'PVTI_1', isArchived: false,
          content: { __typename: 'Issue', id: 'I_1', title: 'Task', body: '', state: 'OPEN', url: 'https://example.test/1' },
          fieldValues: { nodes: [] }
        }] }
      } } };
    } else if (query.includes('updateIssue')) {
      mutations.push('close');
      data = { updateIssue: { issue: { id: 'I_1', state: 'CLOSED' } } };
    } else if (query.includes('deleteProjectV2Item')) {
      mutations.push('delete');
      data = { deleteProjectV2Item: { deletedItemId: 'PVTI_1' } };
    } else {
      throw new Error('Unexpected GraphQL operation');
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
    if (previousDisableGh === undefined) delete process.env.MINEPROGRESS_DISABLE_GH_AUTH; else process.env.MINEPROGRESS_DISABLE_GH_AUTH = previousDisableGh;
  });

  const result = await run(['unbind', 'PVTI_1', '--delete', '--session', 'session-1', '--data-dir', dataDir]);
  assert.deepEqual(mutations, ['close', 'delete']);
  assert.equal(result.changed, true);
  assert.deepEqual(result.deletion, { itemId: 'PVTI_1', projectItemDeleted: true, issueClosed: true });
  assert.deepEqual((await readState(dataDir, 'session-1')).boundItems, []);
});
