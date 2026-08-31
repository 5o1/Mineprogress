import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitPendingUpdate as submitBackendUpdate } from '../src/backend/application.mjs';
import { unresolvedErrors } from '../src/backend/errors.mjs';
import { handleUserPrompt } from '../src/backend/lifecycle.mjs';
import { bindItem, openSession, readState, writeState } from '../src/backend/state.mjs';
import { submitPendingUpdate } from '../src/frontends/codex/cli.mjs';
import { dispatchCodexHook } from '../src/frontends/codex/hook.mjs';
import {
  beginSubmissionElevation,
  requestSubmissionElevation
} from '../src/frontends/codex/submission-elevation.mjs';

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
    evidenceFacts: [],
    evidenceRevisions: { PVTI_1: 0 },
    intentRevisions: { PVTI_1: 0 },
    satisfiedStatusIntents: [],
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

test('sandbox-blocked daily submission is retained and completed by one elevated retry', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-daily-elevation-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    owner: 'octocat', ownerType: 'user', projectNumber: 1
  }));
  const { state } = await openSession(dataDir, 'session-elevation');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser', contentId: 'I_1', contentType: 'issue' });
  state.dailySubmissionDate = '2026-08-30';
  state.pendingPlan = pendingPlan('Ready after elevation.');
  await writeState(dataDir, state);

  let blockedCalls = 0;
  const blockedRuntime = {
    dataDir,
    resourceRoot: root,
    environment: {},
    now: () => new Date(2026, 7, 31, 9, 0, 0),
    githubClient: async () => {
      blockedCalls++;
      throw Object.assign(new Error('fetch failed'), { code: 'GH_NETWORK_ERROR' });
    }
  };
  const first = await dispatchCodexHook('user-prompt', {
    session_id: 'session-elevation', turn_id: 'turn-1', prompt: 'Continue.'
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    now: blockedRuntime.now,
    clientProvider: blockedRuntime.githubClient
  });
  assert.equal(first.elevationRequest.status, 'required');
  assert.equal(blockedCalls, 1);
  let restored = await readState(dataDir, 'session-elevation');
  assert.equal(restored.pendingPlan.submissionBlock.status, 'required');
  assert.equal(restored.pendingPlan.attempts.length, 0);
  assert.deepEqual(restored.journal.map(event => event.text), ['Continue.']);
  let errors = await unresolvedErrors(dataDir, { sessionId: 'session-elevation' });
  assert.deepEqual(errors.map(error => error.errorCode), ['SANDBOX_NETWORK_DENIED']);

  const second = await dispatchCodexHook('user-prompt', {
    session_id: 'session-elevation', turn_id: 'turn-2', prompt: 'Keep going.'
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    now: blockedRuntime.now,
    clientProvider: blockedRuntime.githubClient
  });
  assert.equal(second.elevationRequest.errorId, first.elevationRequest.errorId);
  assert.equal(blockedCalls, 1);
  errors = await unresolvedErrors(dataDir, { sessionId: 'session-elevation' });
  assert.equal(errors.length, 1);

  let remoteSummary = null;
  const client = async (query, variables) => {
    if (query.includes('operation0:updateProjectV2ItemFieldValue')) {
      remoteSummary = variables.value0.text;
      return { operation0: { projectV2Item: { id: 'PVTI_1' } } };
    }
    if (query.includes('query($login')) return projectPage(remoteSummary);
    throw new Error('Unexpected GitHub request.');
  };
  const elevated = await submitPendingUpdate(dataDir, 'session-elevation', {
    elevatedRetry: true
  }, {
    dataDir,
    resourceRoot: root,
    environment: { MINEPROGRESS_ELEVATED_RETRY: '1' },
    clientProvider: async () => client
  });
  assert.equal(elevated.verified, true);
  restored = await readState(dataDir, 'session-elevation');
  assert.equal(restored.pendingPlan, null);
  assert.deepEqual(await unresolvedErrors(dataDir, { sessionId: 'session-elevation' }), []);
});

test('failed elevated submission remains durable and stops automatic retries', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-elevation-failed-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    owner: 'octocat', ownerType: 'user', projectNumber: 1
  }));
  const { state } = await openSession(dataDir, 'session-failed');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser', contentId: 'I_1', contentType: 'issue' });
  state.dailySubmissionDate = '2026-08-30';
  state.pendingPlan = pendingPlan('Still pending.');
  await writeState(dataDir, state);
  let calls = 0;
  const runtime = {
    dataDir,
    resourceRoot: root,
    environment: {},
    now: () => new Date(2026, 7, 31, 9, 0, 0),
    githubClient: async () => {
      calls++;
      throw Object.assign(new Error('offline outside sandbox'), { code: 'GH_NETWORK_ERROR' });
    }
  };
  await dispatchCodexHook('user-prompt', {
    session_id: 'session-failed', turn_id: 'turn-1', prompt: 'Continue.'
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    now: runtime.now,
    clientProvider: runtime.githubClient
  });
  await assert.rejects(submitPendingUpdate(dataDir, 'session-failed', {
    elevatedRetry: true
  }, { ...runtime, clientProvider: runtime.githubClient }), { code: 'GH_NETWORK_ERROR' });
  let restored = await readState(dataDir, 'session-failed');
  assert.equal(restored.pendingPlan.submissionBlock.status, 'failed');
  assert.deepEqual(await unresolvedErrors(dataDir, { sessionId: 'session-failed' }), []);

  const afterFailure = await dispatchCodexHook('user-prompt', {
    session_id: 'session-failed', turn_id: 'turn-2', prompt: 'Do not retry automatically.'
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    now: runtime.now,
    clientProvider: runtime.githubClient
  });
  assert.equal(afterFailure.elevationRequest, undefined);
  assert.equal(calls, 2);
  restored = await readState(dataDir, 'session-failed');
  assert.equal(restored.pendingPlan.submissionBlock.status, 'failed');
});

test('resume resolves an elevation error after interruption between verification and log cleanup', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-elevation-cleanup-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    owner: 'octocat', ownerType: 'user', projectNumber: 1
  }));
  const { state } = await openSession(dataDir, 'session-cleanup');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser', contentId: 'I_1', contentType: 'issue' });
  state.pendingPlan = pendingPlan('Verified before interruption.');
  await writeState(dataDir, state);
  const elevation = await requestSubmissionElevation(dataDir, 'session-cleanup',
    Object.assign(new Error('fetch failed'), { code: 'GH_NETWORK_ERROR' }));

  let remoteSummary = null;
  const client = async (query, variables) => {
    if (query.includes('operation0:updateProjectV2ItemFieldValue')) {
      remoteSummary = variables.value0.text;
      return { operation0: { projectV2Item: { id: 'PVTI_1' } } };
    }
    if (query.includes('query($login')) return projectPage(remoteSummary);
    throw new Error('Unexpected GitHub request.');
  };
  const backendResult = await submitBackendUpdate(dataDir, 'session-cleanup', {}, {
    dataDir,
    resourceRoot: root,
    environment: {},
    githubClient: async () => client
  });
  assert.equal(backendResult.verified, true);
  let restored = await readState(dataDir, 'session-cleanup');
  assert.equal(restored.pendingPlan, null);
  assert.equal(restored.completedSubmissionBlock.errorId, elevation.errorId);
  assert.equal((await unresolvedErrors(dataDir, { sessionId: 'session-cleanup' })).length, 1);

  await dispatchCodexHook('user-prompt', {
    session_id: 'session-cleanup', turn_id: 'turn-resume', prompt: 'Resume after interruption.'
  }, { dataDir, resourceRoot: root, environment: {}, clientProvider: async () => client });
  restored = await readState(dataDir, 'session-cleanup');
  assert.equal(restored.completedSubmissionBlock, null);
  assert.deepEqual(await unresolvedErrors(dataDir, { sessionId: 'session-cleanup' }), []);
});

test('resume resolves a preparation elevation after its durable snapshot checkpoint', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-prepare-cleanup-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { state } = await openSession(dataDir, 'session-prepare-cleanup');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' }, { source: 'create' });
  await writeState(dataDir, state);
  const elevation = await requestSubmissionElevation(
    dataDir,
    'session-prepare-cleanup',
    Object.assign(new Error('fetch failed'), { code: 'GH_NETWORK_ERROR' }),
    { action: 'prepare' }
  );
  await beginSubmissionElevation(dataDir, 'session-prepare-cleanup', 'prepare');
  let restored = await readState(dataDir, 'session-prepare-cleanup');
  restored.completedWorkflowBlock = {
    ...restored.workflowBlock,
    completedAt: new Date().toISOString(),
    completionReason: 'prepared'
  };
  restored.workflowBlock = null;
  await writeState(dataDir, restored);
  assert.equal((await unresolvedErrors(dataDir, { sessionId: 'session-prepare-cleanup' })).length, 1);

  await dispatchCodexHook('user-prompt', {
    session_id: 'session-prepare-cleanup', turn_id: 'turn-resume', prompt: 'Resume.'
  }, { dataDir, resourceRoot: root, environment: {} });

  restored = await readState(dataDir, 'session-prepare-cleanup');
  assert.equal(restored.completedWorkflowBlock, null);
  assert.equal(restored.workflowBlock, null);
  assert.deepEqual(await unresolvedErrors(dataDir, { sessionId: 'session-prepare-cleanup' }), []);
  assert.equal(elevation.action, 'prepare');
});
