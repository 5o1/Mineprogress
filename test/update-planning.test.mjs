import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcilePendingUpdate, run, submitPendingUpdate } from '../scripts/mineprogress.mjs';
import { createConfig, saveConfig } from '../scripts/lib/config.mjs';
import { appendJournal, bindItem, openSession, readState, writeState } from '../scripts/lib/state.mjs';

test('reviewed incremental plan is stored before one later GitHub submission', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-planning-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await saveConfig(path.join(dataDir, 'config.json'), createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1
  }));
  const { state } = await openSession(dataDir, 'session-1');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  appendJournal(state, { kind: 'user', turnId: 'turn-1', text: 'Implemented the parser.' });
  appendJournal(state, { kind: 'assistant', turnId: 'turn-1', text: 'Parser tests pass.' });
  await writeState(dataDir, state);

  const planFile = path.join(dataDir, 'plan.json');
  const reviewFile = path.join(dataDir, 'review.json');
  await fs.writeFile(planFile, JSON.stringify({ updates: [{ itemId: 'PVTI_1', status: 'Done', summary: 'Parser implemented and tested.' }] }));
  await fs.writeFile(reviewFile, JSON.stringify({ decision: 'approve', reason: 'Relevant and concise.' }));

  const previousToken = process.env.GITHUB_TOKEN;
  const previousDisableGh = process.env.MINEPROGRESS_DISABLE_GH_AUTH;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.MINEPROGRESS_DISABLE_GH_AUTH = '1';
  let projectReads = 0;
  let submissions = 0;
  globalThis.fetch = async (_url, request) => {
    const { query } = JSON.parse(request.body);
    let data;
    if (query.includes('query($login')) {
      projectReads++;
      data = { user: { projectV2: {
        id: 'PVT_1', title: 'Tasks', public: false,
        repositories: { totalCount: 0, nodes: [] },
        fields: { nodes: [
          { id: 'STATUS', name: 'Status', options: [
            { id: 'TODO', name: 'Todo' },
            { id: 'DONE', name: 'Done' }
          ] },
          { id: 'UPDATE', name: 'Update' }
        ] },
        items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
          id: 'PVTI_1', isArchived: false, content: { title: 'Parser' }, fieldValues: { nodes: submissions >= 2 ? [
            { name: 'Done', optionId: 'DONE', field: { id: 'STATUS', name: 'Status' } },
            { text: 'Parser implemented and tested.', field: { id: 'UPDATE', name: 'Update' } }
          ] : [
            { name: 'Todo', optionId: 'TODO', field: { id: 'STATUS', name: 'Status' } }
          ] }
        }] }
      } } };
    } else if (query.includes('operation0:updateProjectV2ItemFieldValue')) {
      submissions++;
      data = {
        operation0: { projectV2Item: { id: 'PVTI_1' } },
        operation1: { projectV2Item: { id: 'PVTI_1' } }
      };
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

  const prepared = await run(['update', 'prepare', '--session', 'session-1', '--data-dir', dataDir]);
  assert.deepEqual(prepared.existingPlan, { updates: [] });
  assert.equal(prepared.context.length, 2);
  assert.deepEqual(prepared.promptNames, ['bind']);
  assert.equal(prepared.boundItems[0].backfillRequested, true);
  assert.equal((await run(['update', 'stage', '--plan', planFile, '--session', 'session-1', '--data-dir', dataDir])).accepted, true);
  const planned = await run(['update', 'apply', '--review', reviewFile, '--session', 'session-1', '--data-dir', dataDir]);
  assert.equal(planned.queuedOperations, 2);
  assert.equal(projectReads, 1);
  assert.equal(submissions, 0);
  const pendingState = await readState(dataDir, 'session-1');
  assert.equal(pendingState.pendingPlan.plan.updates.length, 1);
  assert.equal(pendingState.pendingPlan.operations.find(operation => operation.kind === 'status').before, 'Todo');

  const submitted = await submitPendingUpdate(dataDir, 'session-1', { verify: false });
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.verified, false);
  assert.equal(submitted.fieldUpdates, 2);
  assert.equal(submissions, 1);
  assert.notEqual((await readState(dataDir, 'session-1')).pendingPlan, null);

  const reconciled = await reconcilePendingUpdate(dataDir, 'session-1');
  assert.equal(reconciled.verified, true);
  assert.equal(submissions, 2);
  const finalState = await readState(dataDir, 'session-1');
  assert.equal(finalState.pendingPlan, null);
  assert.equal(finalState.lastSuccessfulUpdate.sequence, 2);
  assert.equal(projectReads, 3);
});
