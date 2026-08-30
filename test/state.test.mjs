import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendJournal,
  authorizeCommand,
  beginUpdate,
  bindItem,
  completeUpdate,
  completeSubmission,
  controlCommandAction,
  isControlPrompt,
  mergeEvidenceFacts,
  openSession,
  pendingPlanIsCurrent,
  pendingJournal,
  pruneStaleStates,
  readState,
  recoverEvidencePausedUpdate,
  recoverExhaustedUpdate,
  recordPreparedUpdate,
  recordReviewedUpdate,
  recordStatusIntent,
  recordStagedUpdate,
  requireCommandAuthorization,
  resetStagedUpdate,
  retryExhaustedUpdate,
  statePath,
  storePendingPlan,
  unbindItem,
  writeState
} from '../scripts/lib/state.mjs';

async function temporaryData(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('thread state is isolated by hashed session id and restored', async t => {
  const dataDir = await temporaryData(t);
  const first = await openSession(dataDir, 'session/one');
  assert.equal(first.restored, false);
  assert.doesNotMatch(statePath(dataDir, 'session/one'), /session[\\/]one/);
  const second = await openSession(dataDir, 'session/one');
  assert.equal(second.restored, true);
  assert.match(second.state.dailySubmissionDate, /^\d{4}-\d{2}-\d{2}$/u);
});

test('legacy unsubmitted plans are discarded and scheduled for structured backfill', async t => {
  const dataDir = await temporaryData(t);
  const { state } = await openSession(dataDir, 'legacy');
  bindItem(state, { itemId: 'PVTI_1', title: 'Legacy item' });
  state.planFormatVersion = 4;
  state.pendingPlan = { plan: { updates: [{ itemId: 'PVTI_1', summary: 'Old summary.' }] }, attempts: [] };
  await writeState(dataDir, state);
  const migrated = await readState(dataDir, 'legacy');
  assert.equal(migrated.planFormatVersion, 5);
  assert.equal(migrated.pendingPlan, null);
  assert.ok(migrated.fullContextRequestedRevision > migrated.fullContextPlannedRevision);
  assert.equal(migrated.boundItems[0].backfillRevision, migrated.fullContextRequestedRevision);
});

test('legacy plans with an attempted submission remain recoverable during migration', async t => {
  const dataDir = await temporaryData(t);
  const { state } = await openSession(dataDir, 'attempted-legacy');
  bindItem(state, { itemId: 'PVTI_1', title: 'Legacy item' });
  state.planFormatVersion = 4;
  state.pendingPlan = {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'Possibly submitted.' }] },
    attempts: [{ attemptId: 'attempt-1' }]
  };
  await writeState(dataDir, state);
  const migrated = await readState(dataDir, 'attempted-legacy');
  assert.equal(migrated.planFormatVersion, 5);
  assert.notEqual(migrated.pendingPlan, null);
  assert.ok(migrated.fullContextRequestedRevision > migrated.fullContextPlannedRevision);
});

test('plan format migration reopens only created-item proposal initialization', async t => {
  const dataDir = await temporaryData(t);
  const { state } = await openSession(dataDir, 'proposal-migration');
  bindItem(state, { itemId: 'CREATED', title: 'Created' }, { source: 'create' });
  bindItem(state, { itemId: 'BOUND', title: 'Bound' }, { source: 'bind' });
  delete state.boundItems[0].proposalInitialized;
  delete state.boundItems[1].proposalInitialized;
  state.planFormatVersion = 3;
  await writeState(dataDir, state);
  const migrated = await readState(dataDir, 'proposal-migration');
  assert.equal(migrated.boundItems[0].proposalInitialized, false);
  assert.equal(migrated.boundItems[1].proposalInitialized, true);
});

test('planning and submission advance separate incremental checkpoints', async t => {
  const dataDir = await temporaryData(t);
  const { state } = await openSession(dataDir, 's1');
  assert.equal(bindItem(state, { itemId: 'PVTI_1', title: 'Ship' }), true);
  assert.equal(bindItem(state, { itemId: 'PVTI_1', title: 'Ship' }), false);
  assert.equal(state.boundItems[0].contentLanguage, 'en');
  assert.equal(state.boundItems[0].primaryRepository, null);
  assert.equal(bindItem(state, { itemId: 'PVTI_1', title: 'Ship' }, { contentLanguage: 'zh-CN' }), true);
  assert.equal(state.boundItems[0].contentLanguage, 'zh-cn');
  assert.equal(bindItem(state, { itemId: 'PVTI_1', title: 'Ship' }, { contentLanguage: 'zh-cn' }), false);
  assert.equal(bindItem(state, { itemId: 'PVTI_1', title: 'Ship' }, {
    contentLanguage: 'zh-cn',
    primaryRepository: 'https://github.com/octocat/ship'
  }), true);
  assert.deepEqual(state.boundItems[0].primaryRepository, {
    url: 'https://github.com/octocat/ship',
    description: 'Primary source repository for Ship.'
  });
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'Implemented the parser.' });
  appendJournal(state, { kind: 'assistant', turnId: 't1', text: 'Tests pass.' });
  const run = beginUpdate(state, 'run-1');
  assert.equal(run.toSequence, 2);
  assert.equal(run.useThreadHistory, true);
  const plan = {
    updates: [{ itemId: 'PVTI_1', summary: 'Parser implemented and tested.' }]
  };
  const review = approveRun(state, run, plan, [1, 2].map(sequence => ({
    sequence,
    disposition: 'included',
    itemIds: ['PVTI_1'],
    reason: 'The journal evidence is represented in the changed Project summary.'
  })));
  storePendingPlan(state, 'run-1', {
    updates: [{ itemId: 'PVTI_1', summary: 'Parser implemented and tested.' }]
  }, {
    projectId: 'PVT_1',
    operations: [{ itemId: 'PVTI_1', fieldId: 'PVTF_UPDATE', value: { text: 'Parser implemented and tested.' } }]
  }, review);
  assert.deepEqual(pendingJournal(state), []);
  assert.equal(state.lastPlannedUpdate.sequence, 2);
  assert.equal(state.fullContextPlannedRevision, state.fullContextRequestedRevision);
  assert.equal(state.lastSuccessfulUpdate, null);
  assert.equal(state.pendingPlan.plan.updates.length, 1);
  completeSubmission(state);
  assert.equal(state.lastSuccessfulUpdate.sequence, 2);
  assert.equal(state.pendingPlan, null);
  assert.equal(unbindItem(state, 'PVTI_1'), true);
  await writeState(dataDir, state);
  assert.deepEqual((await readState(dataDir, 's1')).boundItems, []);
});

test('mineprogress prompts are control events and are not journal content', () => {
  for (const command of ['init', 'create', 'bind', 'unbind', 'update', 'check', 'status']) {
    assert.equal(isControlPrompt(`$mineprogress:${command}`), true, command);
  }
  assert.equal(isControlPrompt('$mineprogress check'), false);
  assert.equal(isControlPrompt('$mineprogress:mineprogress check'), false);
  assert.equal(isControlPrompt('please update the code'), false);
  assert.equal(isControlPrompt('Stop hook (blocked) feedback: Mineprogress has an update pending. Run node hook.mjs.'), false);
});

test('mutating commands consume explicit short-lived user authorization', () => {
  const state = newStateForTest();
  assert.equal(controlCommandAction('$mineprogress:create "Task"'), 'create');
  assert.equal(controlCommandAction('$mineprogress:bind PVTI_1'), 'bind');
  assert.equal(controlCommandAction('$mineprogress:unbind PVTI_1'), 'unbind');
  assert.equal(controlCommandAction('$mineprogress:update retry'), 'update_retry');
  assert.equal(controlCommandAction('$mineprogress:status resolve error-1'), 'status_resolve');
  assert.equal(controlCommandAction('$mineprogress:init'), 'init');
  assert.equal(controlCommandAction('$mineprogress:check'), 'check');
  assert.equal(controlCommandAction('$mineprogress create "Task"'), null);
  assert.equal(authorizeCommand(state, 'create', 'turn-1'), true);
  const consume = requireCommandAuthorization(state, 'create');
  consume();
  assert.throws(() => requireCommandAuthorization(state, 'create'), { code: 'USER_AUTHORIZATION_REQUIRED' });
  assert.equal(controlCommandAction('Use Mineprogress to update retry'), 'update_retry');
});

test('new journal events do not replace an active recoverable transaction', () => {
  const state = { ...newStateForTest(), journal: [], nextSequence: 1 };
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'First change' });
  const first = beginUpdate(state, 'run-1');
  first.appliedOperations.push('PVTI_1:summary:key');
  appendJournal(state, { kind: 'user', turnId: 't2', text: 'Later change' });
  const resumed = beginUpdate(state, 'run-2');
  assert.equal(resumed.runId, 'run-1');
  assert.equal(resumed.toSequence, 1);
  assert.deepEqual(resumed.appliedOperations, ['PVTI_1:summary:key']);
  approveRun(state, resumed, { updates: [] }, [{
    sequence: 1,
    disposition: 'irrelevant',
    itemIds: [],
    reason: 'The entry contains no durable project requirement or result.'
  }]);
  completeUpdate(state, 'run-1');
  assert.equal(pendingJournal(state).length, 1);
});

test('interrupted journal batches resume by phase and advance only after complete review', async t => {
  const dataDir = await temporaryData(t);
  const { state } = await openSession(dataDir, 'interrupted');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  state.fullContextPlannedRevision = state.fullContextRequestedRevision;
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'Implement the parser.' });
  appendJournal(state, { kind: 'assistant', turnId: 't1', text: 'Implementation and tests are complete.' });
  const run = beginUpdate(state, 'run-interrupted');
  recordPreparedUpdate(state, run.runId, {
    projectSnapshot: { id: 'PVT_1', fields: [], normalizedItems: [] },
    referenceLinks: []
  });
  await writeState(dataDir, state);

  let restored = await readState(dataDir, 'interrupted');
  assert.equal(restored.activeUpdate.phase, 'prepared');
  assert.deepEqual(restored.activeUpdate.journalSequences, [1, 2]);
  assert.equal(restored.lastPlannedUpdate, null);
  assert.deepEqual(restored.journal.map(event => event.sequence), [1, 2]);

  recordStagedUpdate(restored, run.runId, {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'Parser complete.' }] },
    staticReport: { valid: true, errors: [] }
  });
  await writeState(dataDir, restored);
  restored = await readState(dataDir, 'interrupted');
  assert.equal(beginUpdate(restored, 'replacement-run').runId, run.runId);
  assert.equal(restored.activeUpdate.phase, 'staged');

  recordReviewedUpdate(restored, run.runId, {
    decision: 'approve',
    reason: 'Only part of the batch was classified.',
    journalCoverage: [{
      sequence: 1,
      disposition: 'included',
      itemIds: ['PVTI_1'],
      reason: 'The first event appears in the changed summary.'
    }]
  });
  assert.throws(() => storePendingPlan(restored, run.runId, restored.activeUpdate.stagedPlan, {
    projectId: 'PVT_1',
    operations: []
  }, restored.activeUpdate.approvedReview), { code: 'JOURNAL_COVERAGE_INCOMPLETE' });
  assert.equal(restored.pendingPlan, null);
  assert.throws(() => completeUpdate(restored, run.runId), { code: 'JOURNAL_COVERAGE_INCOMPLETE' });
  assert.deepEqual(restored.journal.map(event => event.sequence), [1, 2]);

  resetStagedUpdate(restored, run.runId);
  recordStagedUpdate(restored, run.runId, {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'Parser complete.' }] },
    staticReport: { valid: true, errors: [] }
  });
  recordReviewedUpdate(restored, run.runId, {
    decision: 'approve',
    reason: 'One durable event is still missing.',
    journalCoverage: [
      {
        sequence: 1,
        disposition: 'included',
        itemIds: ['PVTI_1'],
        reason: 'The first event is represented in the changed Project summary.'
      },
      {
        sequence: 2,
        disposition: 'missing',
        itemIds: [],
        reason: 'The second event is not yet represented in the proposed plan.'
      }
    ]
  });
  assert.throws(() => completeUpdate(restored, run.runId), { code: 'JOURNAL_COVERAGE_INCOMPLETE' });
  assert.deepEqual(restored.journal.map(event => event.sequence), [1, 2]);

  resetStagedUpdate(restored, run.runId);
  recordStagedUpdate(restored, run.runId, {
    plan: { updates: [{ itemId: 'PVTI_1', summary: 'Parser complete.' }] },
    staticReport: { valid: true, errors: [] }
  });
  recordReviewedUpdate(restored, run.runId, {
    decision: 'approve',
    reason: 'Every event in the fixed batch is classified.',
    journalCoverage: [1, 2].map(sequence => ({
      sequence,
      disposition: 'included',
      itemIds: ['PVTI_1'],
      reason: 'The event is represented in the changed Project summary.'
    }))
  });
  appendJournal(restored, { kind: 'user', turnId: 't2', text: 'Add another requirement.' });
  completeUpdate(restored, run.runId);
  assert.equal(restored.lastPlannedUpdate.sequence, 2);
  assert.deepEqual(restored.journal.map(event => event.sequence), [3]);
});

test('legacy approved active runs without coverage resume at review instead of advancing', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-state-legacy-review-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { state } = await openSession(dataDir, 'legacy-reviewed');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  appendJournal(state, { kind: 'assistant', turnId: 'turn-1', text: 'Parser is complete.' });
  const run = beginUpdate(state, 'legacy-run');
  run.phase = 'reviewed';
  run.projectSnapshot = { normalizedItems: [] };
  run.stagedPlan = { updates: [{ itemId: 'PVTI_1', summary: 'Parser complete.' }] };
  run.approvedReview = { decision: 'approve', reason: 'Legacy approval.' };
  await writeState(dataDir, state);
  const restored = await readState(dataDir, 'legacy-reviewed');
  assert.equal(restored.activeUpdate.phase, 'staged');
  assert.equal(restored.activeUpdate.approvedReview, null);
  assert.equal(restored.journal.length, 1);
  assert.equal(restored.lastPlannedUpdate, null);
});

test('a binding can start a full-history update without locally journaled context', () => {
  const state = newStateForTest();
  bindItem(state, { itemId: 'PVTI_1', title: 'Imported thread task' }, { source: 'create' });
  assert.equal(state.boundItems[0].bindingSource, 'create');
  assert.equal(state.boundItems[0].proposalInitialized, false);
  assert.equal(state.boundItems[0].backfillRevision, 1);
  const run = beginUpdate(state, 'full-run');
  assert.equal(run.toSequence, 0);
  assert.equal(run.useThreadHistory, true);
  approveRun(state, run, { updates: [] }, []);
  completeUpdate(state, 'full-run');
  assert.equal(state.fullContextPlannedRevision, 1);
  bindItem(state, { itemId: 'PVTI_2', title: 'Existing item' }, { source: 'bind' });
  assert.equal(state.boundItems[1].bindingSource, 'bind');
  assert.equal(state.boundItems[1].proposalInitialized, true);
  assert.equal(state.boundItems[1].backfillRevision, 2);
  const second = beginUpdate(state, 'second-full-run');
  approveRun(state, second, { updates: [] }, []);
  completeUpdate(state, second.runId);
  assert.equal(state.fullContextPlannedRevision, 2);
  assert.equal(beginUpdate(state), null);
});

test('successful proposal submission permanently initializes the created-item body', () => {
  const state = newStateForTest();
  bindItem(state, { itemId: 'PVTI_1', title: 'Created item' }, { source: 'create' });
  const run = beginUpdate(state, 'proposal-run');
  const proposalPlan = {
    updates: [{ itemId: 'PVTI_1', body: 'Proposal' }]
  };
  const review = approveRun(state, run, proposalPlan, []);
  storePendingPlan(state, run.runId, proposalPlan, {
    projectId: 'PVT_1',
    operations: [{ itemId: 'PVTI_1', kind: 'proposalBody' }]
  }, review);
  completeSubmission(state);
  assert.equal(state.boundItems[0].proposalInitialized, true);
});

test('bindings retain linked content metadata for explicit synchronized deletion', () => {
  const state = newStateForTest();
  bindItem(state, {
    itemId: 'PVTI_1', title: 'Issue task', contentId: 'I_1', contentType: 'issue',
    url: 'https://example.test/1', repository: 'octocat/todos'
  });
  assert.deepEqual({
    contentId: state.boundItems[0].contentId,
    contentType: state.boundItems[0].contentType,
    url: state.boundItems[0].url,
    repository: state.boundItems[0].repository
  }, {
    contentId: 'I_1', contentType: 'issue', url: 'https://example.test/1', repository: 'octocat/todos'
  });
});

test('exhausted updates recover automatically only after later journal evidence', () => {
  const state = newStateForTest();
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'Change' });
  const exhausted = beginUpdate(state, 'run-1');
  exhausted.exhausted = true;
  exhausted.exhaustionErrorId = 'error-1';
  assert.equal(recoverExhaustedUpdate(state), null);

  appendJournal(state, { kind: 'user', turnId: 't2', text: 'Later evidence' });
  const recovered = recoverExhaustedUpdate(state, 'run-2');
  assert.equal(recovered.runId, 'run-2');
  assert.deepEqual(recovered.journalSequences, [1, 2]);
  assert.deepEqual(recovered.recoveredExhaustion, {
    runId: 'run-1', errorId: 'error-1', throughSequence: 1,
    reason: 'later-evidence', resolvedAt: null
  });
  assert.equal(recovered.attempt, 0);

  recovered.exhausted = true;
  const retried = retryExhaustedUpdate(state);
  assert.notEqual(retried.runId, 'run-2');
  assert.equal(retried.fromSequence, 0);
});

test('an update engine revision automatically retries an older exhausted run once', () => {
  const state = newStateForTest();
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'Evidence' });
  const exhausted = beginUpdate(state, 'run-old-engine');
  exhausted.engineRevision = 1;
  exhausted.exhausted = true;
  exhausted.exhaustionErrorId = 'error-old-engine';

  const recovered = recoverExhaustedUpdate(state, 'run-current-engine');
  assert.equal(recovered.runId, 'run-current-engine');
  assert.equal(recovered.engineRevision, 2);
  assert.deepEqual(recovered.recoveredExhaustion, {
    runId: 'run-old-engine', errorId: 'error-old-engine', throughSequence: 1,
    reason: 'engine-upgrade', resolvedAt: null
  });
  recovered.exhausted = true;
  assert.equal(recoverExhaustedUpdate(state), null);
});

test('a review paused for evidence resumes only when later journal evidence exists', () => {
  const state = newStateForTest();
  appendJournal(state, { kind: 'user', turnId: 't1', text: 'Requirement' });
  const paused = beginUpdate(state, 'run-awaiting-evidence');
  paused.awaitingEvidence = true;
  assert.equal(recoverEvidencePausedUpdate(state), null);

  appendJournal(state, { kind: 'assistant', turnId: 't1', text: 'Verified implementation result' });
  const recovered = recoverEvidencePausedUpdate(state, 'run-with-evidence');
  assert.equal(recovered.runId, 'run-with-evidence');
  assert.deepEqual(recovered.journalSequences, [1, 2]);
  assert.deepEqual(recovered.recoveredEvidencePause, {
    runId: 'run-awaiting-evidence', throughSequence: 1
  });
});

test('verified evidence and status intent revisions survive transaction interruption boundaries', () => {
  const state = newStateForTest();
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser', contentType: 'issue' });
  state.fullContextPlannedRevision = state.fullContextRequestedRevision;
  const event = appendJournal(state, {
    kind: 'user', turnId: 'turn-1', text: 'The parser implementation and verification are complete.'
  });
  assert.equal(recordStatusIntent(state, 'PVTI_1', 'Done', event.sequence), true);
  assert.equal(recordStatusIntent(state, 'PVTI_1', 'Done', event.sequence), false);
  const run = beginUpdate(state, 'evidence-run');
  const plan = { updates: [{ itemId: 'PVTI_1', status: 'Done' }] };
  const review = approveRun(state, run, plan, [{
    sequence: event.sequence,
    disposition: 'included',
    itemIds: ['PVTI_1'],
    reason: 'The completion statement supports the terminal transition.'
  }]);
  storePendingPlan(state, run.runId, plan, {
    projectId: 'PVT_1',
    operations: [{ key: 'status-done', itemId: 'PVTI_1', kind: 'status' }]
  }, review, {
    satisfiedStatusIntents: [{ itemId: 'PVTI_1', targetStatus: 'Done', revision: 1 }]
  });
  assert.equal(state.journal.length, 0);
  assert.equal(state.pendingPlan.evidenceFacts.length, 1);
  assert.equal(state.pendingPlan.evidenceFacts[0].text, 'Status: Done');
  assert.doesNotMatch(state.pendingPlan.evidenceFacts[0].text, /implementation and verification/u);
  assert.equal(pendingPlanIsCurrent(state), true);

  assert.equal(recordStatusIntent(state, 'PVTI_1', 'Review', 2), true);
  assert.equal(state.boundItems[0].statusIntent.revision, 2);
  assert.equal(pendingPlanIsCurrent(state), false);
  completeSubmission(state);
  assert.equal(state.boundItems[0].evidenceLedger.facts.length, 1);
  assert.equal(state.boundItems[0].statusIntent.targetStatus, 'Review');
  assert.equal(state.boundItems[0].statusIntentRevision, 2);
});

test('remote managed evidence is deduplicated in the per-item ledger', () => {
  const state = newStateForTest();
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  const fact = {
    factId: 'github-comment:abc', source: 'github-comment', text: 'Requirements:\nParse input.',
    url: 'https://github.test/comment/1', timestamp: '2026-08-30T00:00:00.000Z'
  };
  assert.equal(mergeEvidenceFacts(state, 'PVTI_1', [fact], { recoveredAt: '2026-08-30T01:00:00.000Z' }), 1);
  assert.equal(mergeEvidenceFacts(state, 'PVTI_1', [fact]), 0);
  assert.equal(state.boundItems[0].evidenceLedger.revision, 1);
  assert.equal(state.boundItems[0].evidenceLedger.recoveredAt, '2026-08-30T01:00:00.000Z');
});

test('stale ended thread state is pruned after retention period', async t => {
  const dataDir = await temporaryData(t);
  const { state } = await openSession(dataDir, 'old-session');
  state.lastEndedAt = '2025-01-01T00:00:00.000Z';
  await writeState(dataDir, state);
  const removed = await pruneStaleStates(dataDir, { retentionDays: 30, now: Date.parse('2026-01-01T00:00:00.000Z') });
  assert.equal(removed, 1);
  assert.equal(await readState(dataDir, 'old-session'), null);
});

function newStateForTest() {
  return {
    version: 1,
    sessionId: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEndedAt: null,
    boundItems: [],
    journal: [],
    controlTurnIds: [],
    nextSequence: 1,
    lastPlannedUpdate: null,
    lastSuccessfulUpdate: null,
    pendingPlan: null,
    activeUpdate: null
  };
}

function approveRun(state, run, plan, journalCoverage) {
  recordPreparedUpdate(state, run.runId, {
    projectSnapshot: { id: 'PVT_1', fields: [], normalizedItems: [] },
    referenceLinks: []
  });
  recordStagedUpdate(state, run.runId, {
    plan,
    staticReport: { valid: true, errors: [] },
    proposalBodyItemIds: []
  });
  const review = { decision: 'approve', reason: 'The complete batch is represented.', journalCoverage };
  recordReviewedUpdate(state, run.runId, review);
  return review;
}
