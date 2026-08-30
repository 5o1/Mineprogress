import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../scripts/mineprogress.mjs';
import { createConfig, saveConfig } from '../scripts/lib/config.mjs';
import { bindItem, openSession, readState, writeState } from '../scripts/lib/state.mjs';
import { statusFixture } from './status-fixture.mjs';

const STATUS = statusFixture();

test('remote terminal status closes an open Issue, discards queued writes, and unbinds', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-terminal-sync-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await saveConfig(path.join(dataDir, 'config.json'), createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { defaultStatus: STATUS.queued, terminalStatuses: [STATUS.terminal] }
  }));
  const { state } = await openSession(dataDir, 'session-terminal-sync');
  bindItem(state, {
    itemId: 'PVTI_1', title: 'Parser', contentId: 'I_1', contentType: 'issue',
    contentState: 'OPEN'
  });
  state.pendingPlan = {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'This must not be written.' }] },
    projectId: 'PVT_1',
    operations: [{
      key: 'summary-op', kind: 'summary', itemId: 'PVTI_1', fieldId: 'UPDATE',
      before: null, expected: 'This must not be written.', value: { text: 'This must not be written.' }
    }],
    throughSequence: 0, submissionStatus: 'ready', attempts: [], evidenceFacts: [],
    evidenceRevisions: { PVTI_1: 0 }, intentRevisions: { PVTI_1: 0 },
    satisfiedStatusIntents: []
  };
  await writeState(dataDir, state);

  const previousToken = process.env.GITHUB_TOKEN;
  const previousDisableGh = process.env.MINEPROGRESS_DISABLE_GH_AUTH;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.MINEPROGRESS_DISABLE_GH_AUTH = '1';
  const calls = [];
  globalThis.fetch = async (_url, request) => {
    const { query } = JSON.parse(request.body);
    if (query.includes('query($login')) {
      calls.push('read-project');
      return {
        ok: true, status: 200,
        json: async () => ({ data: { user: { projectV2: {
          id: 'PVT_1', title: 'Tasks', public: false,
          repositories: { totalCount: 0, nodes: [] },
          fields: { nodes: [{ id: 'STATUS', name: 'Status', options: [
            { id: 'QUEUED', name: STATUS.queued }, { id: 'TERMINAL', name: STATUS.terminal }
          ] }] },
          items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
            id: 'PVTI_1', isArchived: false,
            content: { __typename: 'Issue', id: 'I_1', title: 'Parser', body: '', state: 'OPEN' },
            fieldValues: { nodes: [{
              name: STATUS.terminal, optionId: 'TERMINAL', field: { id: 'STATUS', name: 'Status' }
            }] }
          }] }
        } } } })
      };
    }
    if (query.includes('updateIssue')) {
      calls.push('close-issue');
      return {
        ok: true, status: 200,
        json: async () => ({ data: { updateIssue: { issue: { id: 'I_1', state: 'CLOSED' } } } })
      };
    }
    throw new Error('A queued terminal-item write reached GitHub.');
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
    if (previousDisableGh === undefined) delete process.env.MINEPROGRESS_DISABLE_GH_AUTH; else process.env.MINEPROGRESS_DISABLE_GH_AUTH = previousDisableGh;
  });

  const result = await run([
    'update', 'prepare', '--reconcile-bindings',
    '--session', 'session-terminal-sync', '--data-dir', dataDir
  ]);
  assert.equal(result.outcome, 'paused_no_bindings');
  assert.deepEqual(result.released, ['PVTI_1']);
  assert.deepEqual(result.closedIssues, ['PVTI_1']);
  assert.deepEqual(calls, ['read-project', 'close-issue']);
  const restored = await readState(dataDir, 'session-terminal-sync');
  assert.deepEqual(restored.boundItems, []);
  assert.equal(restored.pendingPlan, null);
});

test('failed Issue closure retains a terminal binding and its queued transaction for retry', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-terminal-close-retry-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await saveConfig(path.join(dataDir, 'config.json'), createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { defaultStatus: STATUS.queued, terminalStatuses: [STATUS.terminal] }
  }));
  const { state } = await openSession(dataDir, 'session-terminal-close-retry');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser', contentId: 'I_1', contentType: 'issue' });
  state.pendingPlan = {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'Retain until terminal synchronization succeeds.' }] },
    projectId: 'PVT_1',
    operations: [{ key: 'summary-op', kind: 'summary', itemId: 'PVTI_1' }],
    throughSequence: 0, submissionStatus: 'ready', attempts: [], evidenceFacts: [],
    evidenceRevisions: { PVTI_1: 0 }, intentRevisions: { PVTI_1: 0 },
    satisfiedStatusIntents: []
  };
  await writeState(dataDir, state);

  const previousToken = process.env.GITHUB_TOKEN;
  const previousDisableGh = process.env.MINEPROGRESS_DISABLE_GH_AUTH;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.MINEPROGRESS_DISABLE_GH_AUTH = '1';
  globalThis.fetch = async (_url, request) => {
    const { query } = JSON.parse(request.body);
    if (query.includes('query($login')) {
      return {
        ok: true, status: 200,
        json: async () => ({ data: { user: { projectV2: {
          id: 'PVT_1', title: 'Tasks', public: false,
          repositories: { totalCount: 0, nodes: [] },
          fields: { nodes: [{ id: 'STATUS', name: 'Status', options: [
            { id: 'QUEUED', name: STATUS.queued }, { id: 'TERMINAL', name: STATUS.terminal }
          ] }] },
          items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
            id: 'PVTI_1', isArchived: false,
            content: { __typename: 'Issue', id: 'I_1', title: 'Parser', body: '', state: 'OPEN' },
            fieldValues: { nodes: [{
              name: STATUS.terminal, optionId: 'TERMINAL', field: { id: 'STATUS', name: 'Status' }
            }] }
          }] }
        } } } })
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ errors: [{ message: 'Issue closure denied.' }] })
    };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
    if (previousDisableGh === undefined) delete process.env.MINEPROGRESS_DISABLE_GH_AUTH; else process.env.MINEPROGRESS_DISABLE_GH_AUTH = previousDisableGh;
  });

  await assert.rejects(run([
    'update', 'prepare', '--reconcile-bindings',
    '--session', 'session-terminal-close-retry', '--data-dir', dataDir
  ]), error => error.code === 'GH_GRAPHQL_ERROR');
  const restored = await readState(dataDir, 'session-terminal-close-retry');
  assert.equal(restored.boundItems.length, 1);
  assert.notEqual(restored.pendingPlan, null);
});
