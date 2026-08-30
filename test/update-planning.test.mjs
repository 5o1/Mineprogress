import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcilePendingUpdate, run, submitPendingUpdate } from '../scripts/mineprogress.mjs';
import { createConfig, saveConfig } from '../scripts/lib/config.mjs';
import { updateProjectMetadata } from '../scripts/lib/metadata.mjs';
import {
  appendJournal,
  beginUpdate,
  bindItem,
  openSession,
  readState,
  recordPreparedUpdate,
  recordReviewedUpdate,
  recordStatusIntent,
  recordStagedUpdate,
  writeState
} from '../scripts/lib/state.mjs';
import { logError, unresolvedErrors } from '../scripts/lib/errors.mjs';
import { storedStatusRules } from '../src/backend/status-rules.mjs';

test('semantic review pauses a fixed batch when durable evidence is still missing', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-evidence-pause-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { defaultStatus: 'Todo', terminalStatuses: ['Done'] }
  });
  await saveConfig(path.join(dataDir, 'config.json'), config);
  const { state } = await openSession(dataDir, 'session-evidence-pause');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser', contentType: 'issue' });
  const event = appendJournal(state, { kind: 'user', turnId: 'turn-1', text: 'Implement the parser.' });
  const update = beginUpdate(state, 'run-evidence-pause');
  recordPreparedUpdate(state, update.runId, { projectSnapshot: {
    id: 'PVT_1', fields: [], availableStatuses: ['Todo', 'Done'],
    statusRules: storedStatusRules({
      statuses: ['Todo', 'Done'].map(name => ({
        name, enterWhen: `Enter ${name} when its boundary is satisfied.`,
        doNotEnterWhen: `Do not enter ${name} when its boundary is unsatisfied.`
      })),
      transitions: [{
        from: 'Todo', to: 'Done', when: 'Implementation and verification are complete.',
        doNotApplyWhen: 'Implementation or verification remains.'
      }]
    }, ['Todo', 'Done']),
    normalizedItems: [{ itemId: 'PVTI_1', title: 'Parser', status: 'Todo', contentType: 'issue' }]
  } });
  recordStagedUpdate(state, update.runId, {
    plan: { updates: [] }, staticReport: { valid: true, errors: [] }
  });
  await writeState(dataDir, state);
  const reviewFile = path.join(dataDir, 'review-missing.json');
  await fs.writeFile(reviewFile, JSON.stringify({
    decision: 'reject', reason: 'The implementation requirement has no durable result evidence yet.',
    journalCoverage: [{
      sequence: event.sequence, disposition: 'missing', itemIds: [],
      reason: 'No verified implementation or test result supports a progress update.'
    }]
  }));

  const result = await run([
    'update', 'apply', '--review', reviewFile,
    '--session', 'session-evidence-pause', '--data-dir', dataDir
  ]);
  assert.equal(result.awaitingEvidence, true);
  const paused = await readState(dataDir, 'session-evidence-pause');
  assert.equal(paused.activeUpdate.phase, 'prepared');
  assert.equal(paused.activeUpdate.awaitingEvidence, true);
  assert.equal(paused.activeUpdate.attempt, 0);
  assert.equal((await run([
    'update', 'prepare', '--session', 'session-evidence-pause', '--data-dir', dataDir
  ])).outcome, 'awaiting_evidence');
});

test('prepare automatically recovers an exhausted batch after later journal evidence', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-auto-recovery-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { defaultStatus: 'Todo', terminalStatuses: ['Done'] }
  });
  await saveConfig(path.join(dataDir, 'config.json'), config);
  const availableStatuses = ['Todo', 'Done'];
  await updateProjectMetadata(dataDir, config, {
    availableStatuses,
    statusRules: storedStatusRules({
      statuses: availableStatuses.map(name => ({
        name,
        enterWhen: `Enter ${name} when its durable boundary is satisfied.`,
        doNotEnterWhen: `Do not enter ${name} while its durable boundary is unsatisfied.`
      })),
      transitions: [{
        from: 'Todo', to: 'Done',
        when: 'Required implementation and verification are complete.',
        doNotApplyWhen: 'Required implementation or verification remains.'
      }]
    }, availableStatuses)
  });
  const { state } = await openSession(dataDir, 'session-auto-recovery');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  appendJournal(state, { kind: 'user', turnId: 'turn-1', text: 'Earlier evidence.' });
  const exhausted = beginUpdate(state, 'run-exhausted');
  exhausted.exhausted = true;
  const error = await logError(dataDir, {
    sessionId: state.sessionId,
    updateRunId: exhausted.runId,
    stage: 'static-validation',
    errorCode: 'REVIEW_EXHAUSTED',
    message: 'The first bounded run was exhausted.'
  });
  exhausted.exhaustionErrorId = error.errorId;
  appendJournal(state, { kind: 'user', turnId: 'turn-2', text: 'Later completion evidence.' });
  await writeState(dataDir, state);

  const previousToken = process.env.GITHUB_TOKEN;
  const previousDisableGh = process.env.MINEPROGRESS_DISABLE_GH_AUTH;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.MINEPROGRESS_DISABLE_GH_AUTH = '1';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { user: { projectV2: {
      id: 'PVT_1', title: 'Tasks', public: false,
      repositories: { totalCount: 0, nodes: [] },
      fields: { nodes: [{ id: 'STATUS', name: 'Status', options: [
        { id: 'TODO', name: 'Todo' }, { id: 'DONE', name: 'Done' }
      ] }] },
      items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        id: 'PVTI_1', isArchived: false, content: { title: 'Parser' },
        fieldValues: { nodes: [{ name: 'Todo', optionId: 'TODO', field: { id: 'STATUS', name: 'Status' } }] }
      }] }
    } } } })
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
    if (previousDisableGh === undefined) delete process.env.MINEPROGRESS_DISABLE_GH_AUTH; else process.env.MINEPROGRESS_DISABLE_GH_AUTH = previousDisableGh;
  });

  const prepared = await run(['update', 'prepare', '--session', 'session-auto-recovery', '--data-dir', dataDir]);
  assert.equal(prepared.outcome, 'generate_and_review');
  assert.deepEqual(prepared.context.map(event => event.sequence), [1, 2]);
  const recovered = await readState(dataDir, 'session-auto-recovery');
  assert.notEqual(recovered.activeUpdate.runId, 'run-exhausted');
  assert.equal(recovered.activeUpdate.recoveredExhaustion.errorId, error.errorId);
  assert.ok(recovered.activeUpdate.recoveredExhaustion.resolvedAt);
  assert.deepEqual(await unresolvedErrors(dataDir, { sessionId: state.sessionId }), []);
});

test('reviewed incremental plan is stored before one later GitHub submission', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-planning-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { defaultStatus: 'Todo', terminalStatuses: ['Done'] }
  });
  await saveConfig(path.join(dataDir, 'config.json'), config);
  const availableStatuses = ['Todo', 'Done'];
  await updateProjectMetadata(dataDir, config, {
    availableStatuses,
    statusRules: storedStatusRules({
      statuses: availableStatuses.map(name => ({
        name,
        enterWhen: `Enter ${name} only when durable repository evidence satisfies its boundary.`,
        doNotEnterWhen: `Do not enter ${name} for questions, plans, or agent control activity.`
      })),
      transitions: [{
        from: 'Todo',
        to: 'Done',
        when: 'Move when required implementation and verification are demonstrably complete.',
        doNotApplyWhen: 'Do not move while required implementation or verification remains.'
      }]
    }, availableStatuses)
  });
  const { state } = await openSession(dataDir, 'session-1');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  appendJournal(state, { kind: 'user', turnId: 'turn-1', text: 'Implemented the parser.' });
  appendJournal(state, { kind: 'assistant', turnId: 'turn-1', text: 'Parser tests pass.' });
  await writeState(dataDir, state);

  const planFile = path.join(dataDir, 'plan.json');
  const reviewFile = path.join(dataDir, 'review.json');
  await fs.writeFile(planFile, JSON.stringify({ updates: [{ itemId: 'PVTI_1', status: 'Done', summary: 'Parser implemented and tested.' }] }));
  await fs.writeFile(reviewFile, JSON.stringify({
    decision: 'approve',
    reason: 'Relevant and concise.',
    journalCoverage: [1, 2].map(sequence => ({
      sequence,
      disposition: 'included',
      itemIds: ['PVTI_1'],
      reason: 'The event is represented in the changed Project status and summary.'
    }))
  }));

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
  assert.equal(prepared.boundItems[0].proposalWritable, false);
  await updateProjectMetadata(dataDir, config, { availableStatuses, statusRules: null });
  assert.equal((await run(['update', 'stage', '--plan', planFile, '--session', 'session-1', '--data-dir', dataDir])).accepted, true);
  const interruptedResume = await run(['update', 'prepare', '--session', 'session-1', '--data-dir', dataDir]);
  assert.equal(interruptedResume.outcome, 'review_staged');
  assert.deepEqual(interruptedResume.stagedPlan, JSON.parse(await fs.readFile(planFile, 'utf8')));
  assert.equal(projectReads, 1);
  const reviewedState = await readState(dataDir, 'session-1');
  recordReviewedUpdate(
    reviewedState,
    reviewedState.activeUpdate.runId,
    JSON.parse(await fs.readFile(reviewFile, 'utf8'))
  );
  await writeState(dataDir, reviewedState);
  const reviewedResume = await run(['update', 'prepare', '--session', 'session-1', '--data-dir', dataDir]);
  assert.equal(reviewedResume.outcome, 'resume_apply');
  const planned = await run(['update', 'apply', '--session', 'session-1', '--data-dir', dataDir]);
  assert.equal(planned.queuedOperations, 2);
  assert.equal(projectReads, 1);
  assert.equal(submissions, 0);
  const pendingState = await readState(dataDir, 'session-1');
  assert.equal(pendingState.pendingPlan.plan.updates.length, 1);
  assert.equal(pendingState.boundItems[0].statusIntent.targetStatus, 'Done');
  assert.deepEqual(pendingState.pendingPlan.satisfiedStatusIntents, [{
    itemId: 'PVTI_1', targetStatus: 'Done', revision: 1
  }]);
  assert.equal(pendingState.pendingPlan.operations.find(operation => operation.kind === 'status').before, 'Todo');
  await updateProjectMetadata(dataDir, config, { availableStatuses, statusRules: prepared.statusRules });

  const originalPendingPlan = structuredClone(pendingState.pendingPlan);
  appendJournal(pendingState, { kind: 'user', turnId: 'turn-2', text: 'Check.' });
  await writeState(dataDir, pendingState);
  const noOpPrepared = await run(['update', 'prepare', '--session', 'session-1', '--data-dir', dataDir]);
  assert.deepEqual(noOpPrepared.existingPlan, originalPendingPlan.plan);
  const noOpFile = path.join(dataDir, 'noop-plan.json');
  await fs.writeFile(noOpFile, JSON.stringify(originalPendingPlan.plan));
  const noOpStage = await run(['update', 'stage', '--plan', noOpFile, '--session', 'session-1', '--data-dir', dataDir]);
  assert.equal(noOpStage.accepted, true);
  const noOpReviewFile = path.join(dataDir, 'noop-review.json');
  await fs.writeFile(noOpReviewFile, JSON.stringify({
    decision: 'approve',
    reason: 'The new journal entry is ordinary Q&A.',
    journalCoverage: [{
      sequence: 3,
      disposition: 'irrelevant',
      itemIds: [],
      reason: 'The check request contains no durable project requirement or verified result.'
    }]
  }));
  const noOp = await run(['update', 'apply', '--review', noOpReviewFile, '--session', 'session-1', '--data-dir', dataDir]);
  assert.equal(noOp.planned, true);
  assert.equal(noOp.planningCheckpointAdvanced, true);
  const afterNoOp = await readState(dataDir, 'session-1');
  assert.deepEqual(afterNoOp.pendingPlan.plan, originalPendingPlan.plan);
  assert.equal(afterNoOp.pendingPlan.throughSequence, 3);
  assert.equal(afterNoOp.activeUpdate, null);
  assert.equal(afterNoOp.lastPlannedUpdate.sequence, 3);

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
  assert.equal(finalState.boundItems[0].statusIntent, null);
  assert.equal(finalState.lastSuccessfulUpdate.sequence, 3);
  assert.equal(projectReads, 4);
});

test('update preparation recovers verified managed comments into item evidence once', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-evidence-recovery-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { defaultStatus: 'Todo', terminalStatuses: ['Done'] }
  });
  await saveConfig(path.join(dataDir, 'config.json'), config);
  const availableStatuses = ['Todo', 'Done'];
  await updateProjectMetadata(dataDir, config, {
    availableStatuses,
    statusRules: storedStatusRules({
      statuses: availableStatuses.map(name => ({
        name, enterWhen: `Enter ${name} when its durable evidence boundary is satisfied.`,
        doNotEnterWhen: `Do not enter ${name} while required evidence remains incomplete.`
      })),
      transitions: [{
        from: 'Todo', to: 'Done', when: 'All required implementation and verification are complete.',
        doNotApplyWhen: 'Required implementation or verification remains incomplete.'
      }]
    }, availableStatuses)
  });
  const { state } = await openSession(dataDir, 'session-evidence');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser', contentId: 'I_1', contentType: 'issue' });
  appendJournal(state, { kind: 'user', turnId: 'turn-1', text: 'Summarize the verified progress.' });
  await writeState(dataDir, state);

  const previousToken = process.env.GITHUB_TOKEN;
  const previousDisableGh = process.env.MINEPROGRESS_DISABLE_GH_AUTH;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.MINEPROGRESS_DISABLE_GH_AUTH = '1';
  let commentReads = 0;
  globalThis.fetch = async (_url, request) => {
    const { query } = JSON.parse(request.body);
    const data = query.includes('query($login') ? { user: { projectV2: {
      id: 'PVT_1', title: 'Tasks', public: false, repositories: { totalCount: 0, nodes: [] },
      fields: { nodes: [
        { id: 'STATUS', name: 'Status', options: [{ id: 'TODO', name: 'Todo' }, { id: 'DONE', name: 'Done' }] },
        { id: 'UPDATE', name: 'Update' }
      ] },
      items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        id: 'PVTI_1', isArchived: false,
        content: { __typename: 'Issue', id: 'I_1', title: 'Parser', body: '', state: 'OPEN', url: 'https://example.test/issues/1' },
        fieldValues: { nodes: [{ name: 'Todo', optionId: 'TODO', field: { id: 'STATUS', name: 'Status' } }] }
      }] }
    } } } : query.includes('node(id:$id)') ? (() => {
      commentReads++;
      return { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        body: '## Progress Update — 2026-08-30\n\n### Requirements\n\nImplement parser.\n\n### Results\n\nParser tests passed.\n\n<!-- mineprogress:comment:verified -->',
        url: 'https://example.test/issues/1#comment', createdAt: '2026-08-30T00:00:00Z'
      }] } } };
    })() : null;
    if (!data) throw new Error('Unexpected GraphQL operation');
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
    if (previousDisableGh === undefined) delete process.env.MINEPROGRESS_DISABLE_GH_AUTH; else process.env.MINEPROGRESS_DISABLE_GH_AUTH = previousDisableGh;
  });

  const prepared = await run(['update', 'prepare', '--session', 'session-evidence', '--data-dir', dataDir]);
  assert.equal(commentReads, 1);
  assert.equal(prepared.boundItems[0].evidenceLedger.facts.length, 1);
  assert.match(prepared.boundItems[0].evidenceLedger.facts[0].text, /Parser tests passed/u);
  const stored = await readState(dataDir, 'session-evidence');
  assert.ok(stored.boundItems[0].evidenceLedger.recoveredAt);
});

test('submission response persistence preserves journal and intent written during network I/O', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-submit-concurrency-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await saveConfig(path.join(dataDir, 'config.json'), createConfig({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    kanban: { defaultStatus: 'Todo', terminalStatuses: ['Done'] }
  }));
  const { state } = await openSession(dataDir, 'session-concurrency');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  state.pendingPlan = {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'Parser ready.' }] },
    projectId: 'PVT_1',
    operations: [{
      key: 'PVTI_1:summary:ready', kind: 'summary', itemId: 'PVTI_1', fieldId: 'UPDATE',
      before: null, expected: 'Parser ready.', value: { text: 'Parser ready.' }
    }],
    throughSequence: 0, submissionStatus: 'ready', attempts: [],
    evidenceFacts: [], evidenceRevisions: { PVTI_1: 0 }, intentRevisions: { PVTI_1: 0 },
    satisfiedStatusIntents: []
  };
  await writeState(dataDir, state);

  const previousToken = process.env.GITHUB_TOKEN;
  const previousDisableGh = process.env.MINEPROGRESS_DISABLE_GH_AUTH;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.MINEPROGRESS_DISABLE_GH_AUTH = '1';
  let releaseMutation;
  let mutationStarted;
  const started = new Promise(resolve => { mutationStarted = resolve; });
  const released = new Promise(resolve => { releaseMutation = resolve; });
  globalThis.fetch = async (_url, request) => {
    const { query } = JSON.parse(request.body);
    assert.match(query, /operation0:updateProjectV2ItemFieldValue/u);
    mutationStarted();
    await released;
    return {
      ok: true, status: 200,
      json: async () => ({ data: { operation0: { projectV2Item: { id: 'PVTI_1' } } } })
    };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
    if (previousDisableGh === undefined) delete process.env.MINEPROGRESS_DISABLE_GH_AUTH; else process.env.MINEPROGRESS_DISABLE_GH_AUTH = previousDisableGh;
  });

  const submitting = submitPendingUpdate(dataDir, 'session-concurrency', { verify: false });
  await started;
  const duringRequest = await readState(dataDir, 'session-concurrency');
  const event = appendJournal(duringRequest, { kind: 'user', turnId: 'turn-2', text: '项目结束了。' });
  recordStatusIntent(duringRequest, 'PVTI_1', 'Done', event.sequence, { role: 'completed' });
  await writeState(dataDir, duringRequest);
  releaseMutation();
  await submitting;

  const restored = await readState(dataDir, 'session-concurrency');
  assert.deepEqual(restored.journal.map(entry => entry.text), ['项目结束了。']);
  assert.equal(restored.boundItems[0].statusIntent.targetStatus, 'Done');
  assert.ok(restored.pendingPlan.attempts[0].responseReceivedAt);
});
