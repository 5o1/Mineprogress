import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUserPrompt } from '../src/backend/lifecycle.mjs';
import { bindItem, openSession, readState, writeState } from '../src/backend/state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function pendingPlan(summary, before = null) {
  return {
    plan: { updates: [{ itemId: 'PVTI_1', summary }] },
    projectId: 'PVT_1',
    operations: [{
      key: `PVTI_1:summary:${summary}`,
      kind: 'summary',
      itemId: 'PVTI_1',
      fieldId: 'UPDATE',
      before,
      expected: summary,
      value: { text: summary }
    }],
    throughSequence: 0,
    approvedAt: new Date().toISOString(),
    submissionStatus: 'ready',
    attempts: [],
    review: { decision: 'approve', reason: 'Verified.' }
  };
}

function projectPage(summary) {
  return {
    user: { projectV2: {
      id: 'PVT_1',
      public: true,
      repositories: { totalCount: 0, nodes: [] },
      fields: { nodes: [{ id: 'UPDATE', name: 'Update' }] },
      items: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: 'PVTI_1',
          isArchived: false,
          content: { __typename: 'Issue', id: 'I_1', title: 'Parser', body: '', state: 'OPEN' },
          fieldValues: { nodes: summary === null ? [] : [{ text: summary, field: { name: 'Update' } }] }
        }]
      }
    } },
    organization: null
  };
}

test('first UserPromptSubmit after a date change submits once before journaling', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-daily-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    owner: 'octocat', ownerType: 'user', projectNumber: 1
  }));
  const { state } = await openSession(dataDir, 'session-daily');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser', contentId: 'I_1', contentType: 'issue' });
  state.dailySubmissionDate = '2026-08-30';
  state.pendingPlan = pendingPlan('Previous day complete.');
  await writeState(dataDir, state);

  let remoteSummary = null;
  let mutations = 0;
  const client = async (query, variables) => {
    if (query.includes('operation0:updateProjectV2ItemFieldValue')) {
      mutations++;
      assert.deepEqual((await readState(dataDir, 'session-daily')).journal, []);
      remoteSummary = variables.value0.text;
      return { operation0: { projectV2Item: { id: 'PVTI_1' } } };
    }
    if (query.includes('query($login')) return projectPage(remoteSummary);
    throw new Error('Unexpected GitHub request.');
  };
  const runtime = {
    dataDir,
    resourceRoot: root,
    environment: {},
    now: () => new Date(2026, 7, 31, 9, 0, 0),
    githubClient: async () => client
  };
  const first = await handleUserPrompt({
    type: 'user-prompt', sessionId: 'session-daily', turnId: 'turn-1',
    prompt: 'Start the new day.', commandAction: null
  }, runtime);
  assert.equal(first.dailySubmission.verified, true);
  assert.equal(mutations, 1);
  let restored = await readState(dataDir, 'session-daily');
  assert.equal(restored.dailySubmissionDate, '2026-08-31');
  assert.equal(restored.pendingPlan, null);
  assert.deepEqual(restored.journal.map(event => event.text), ['Start the new day.']);

  restored.pendingPlan = pendingPlan('New same-day work.', remoteSummary);
  await writeState(dataDir, restored);
  const second = await handleUserPrompt({
    type: 'user-prompt', sessionId: 'session-daily', turnId: 'turn-2',
    prompt: 'Continue today.', commandAction: null
  }, runtime);
  assert.equal(second.dailySubmission, undefined);
  assert.equal(mutations, 1);
  restored = await readState(dataDir, 'session-daily');
  assert.notEqual(restored.pendingPlan, null);
  assert.deepEqual(restored.journal.map(event => event.text), ['Start the new day.', 'Continue today.']);
});
