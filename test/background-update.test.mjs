import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBackgroundUpdate } from '../scripts/background-update.mjs';
import { runHook } from '../src/frontends/codex/background-update.mjs';
import { appendJournal, beginUpdate, bindItem, openSession, writeState } from '../src/backend/state.mjs';

test('background worker generates and reviews a plan without submitting it', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const prompts = [];
  const forks = [];
  const prepared = {
    outcome: 'generate_and_review',
    prompt: 'Update contract',
    existingPlan: { updates: [] },
    availableStatuses: ['Todo', 'Done'],
    statusRules: { transitions: [{
      from: 'Todo',
      to: 'Done',
      when: 'Required implementation and verification are complete.',
      doNotApplyWhen: 'Required work or verification remains incomplete.'
    }] },
    boundItems: [{ itemId: 'PVTI_1', title: 'Parser', contentLanguage: 'en' }],
    referenceLinks: ['https://github.com/example/parser'],
    context: [{ sequence: 1, kind: 'user', text: 'Parser is complete.' }],
    useThreadHistory: true,
    promptNames: ['create'],
    planningDate: '2026-08-30',
    model: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
    reviewModel: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' }
  };
  const runCommand = async argv => {
    calls.push(argv.slice(0, 2).join(' '));
    if (argv[1] === 'prepare') return prepared;
    if (argv[1] === 'stage') {
      const plan = JSON.parse(await fs.readFile(argv[argv.indexOf('--plan') + 1], 'utf8'));
      assert.deepEqual(plan, { updates: [{ itemId: 'PVTI_1', status: 'Done', summary: 'Parser completed.' }] });
      return { accepted: true, staticReport: { valid: true, errors: [] }, plan };
    }
    if (argv[1] === 'apply') {
      const review = JSON.parse(await fs.readFile(argv[argv.indexOf('--review') + 1], 'utf8'));
      assert.deepEqual(review, {
        decision: 'approve',
        reason: 'Relevant and redacted.',
        journalCoverage: [{
          sequence: 1,
          disposition: 'included',
          itemIds: ['PVTI_1'],
          reason: 'The completed parser is represented by the changed bound item.'
        }]
      });
      return { planned: true, queuedUpdates: 1 };
    }
    throw new Error(`Unexpected command: ${argv.join(' ')}`);
  };
  const invokeModel = async input => {
    prompts.push(input.prompt);
    forks.push(input.forkSessionId);
    if ('updates' in input.schema.properties) {
      assert.deepEqual(input.schema.properties.updates.items.required, ['itemId', 'status', 'summary', 'body', 'comment']);
      assert.deepEqual(input.schema.properties.updates.items.properties.itemId.enum, ['PVTI_1']);
      assert.deepEqual(input.schema.properties.updates.items.properties.status.enum, ['Todo', 'Done', null]);
      return { updates: [{ itemId: 'PVTI_1', status: 'Done', summary: 'Parser completed.', body: null, comment: null }] };
    }
    assert.deepEqual(input.schema.required, ['decision', 'reason', 'journalCoverage']);
    return {
      decision: 'approve',
      reason: 'Relevant and redacted.',
      journalCoverage: [{
        sequence: 1,
        disposition: 'included',
        itemIds: ['PVTI_1'],
        reason: 'The completed parser is represented by the changed bound item.'
      }]
    };
  };

  const result = await runBackgroundUpdate(dataDir, 'session-1', { runCommand, invokeModel });
  assert.equal(result.planned, true);
  assert.deepEqual(calls, ['update prepare', 'update stage', 'update apply']);
  assert.equal(calls.includes('update submit'), false);
  assert.equal(prompts.length, 2);
  assert.deepEqual(forks, ['session-1', 'session-1']);
  assert.match(prompts[0], /Parser is complete/);
  assert.match(prompts[0], /contentLanguage/);
  assert.match(prompts[0], /https:\/\/github.com\/example\/parser/);
  assert.match(prompts[0], /Required implementation and verification are complete/);
  assert.match(prompts[0], /messages from before Mineprogress was installed/);
  assert.match(prompts[1], /proposedPlan/);
  assert.match(prompts[1], /Reviewer checklist/);
  assert.match(prompts[1], /Required work or verification remains incomplete/);
});

test('background generation receives static validation feedback on its next bounded attempt', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-feedback-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let prepareCount = 0;
  let stageCount = 0;
  const prompts = [];
  const result = await runBackgroundUpdate(dataDir, 'session-feedback', {
    runCommand: async argv => {
      if (argv[1] === 'prepare') {
        prepareCount++;
        return {
          outcome: 'generate_and_review',
          prompt: 'Update contract',
          previousAttemptErrors: prepareCount === 1 ? [] : ['updates[0].summary must use the item content language en.'],
          existingPlan: { updates: [] },
          availableStatuses: ['Todo', 'Done'],
          statusRules: null,
          boundItems: [{ itemId: 'PVTI_1', title: 'Parser', contentLanguage: 'en' }],
          referenceLinks: [], context: [{ sequence: 1, kind: 'user', text: '完成。' }],
          useThreadHistory: false, promptNames: ['update'], planningDate: '2026-08-30',
          model: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
          reviewModel: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' }
        };
      }
      if (argv[1] === 'stage') {
        stageCount++;
        return stageCount === 1
          ? { accepted: false, exhausted: false, errors: ['updates[0].summary must use the item content language en.'] }
          : { accepted: true, plan: { updates: [] }, staticReport: { valid: true, errors: [] } };
      }
      if (argv[1] === 'apply') return { planned: true, queuedUpdates: 0 };
      throw new Error(`Unexpected command: ${argv.join(' ')}`);
    },
    invokeModel: async input => {
      prompts.push(input.prompt);
      if ('updates' in input.schema.properties) return { updates: [] };
      return {
        decision: 'approve', reason: 'No durable delta.',
        journalCoverage: [{ sequence: 1, disposition: 'irrelevant', itemIds: [], reason: 'No verified result.' }]
      };
    }
  });
  assert.equal(result.planned, true);
  assert.equal(prepareCount, 2);
  assert.equal(stageCount, 2);
  assert.doesNotMatch(prompts[0], /previous candidate failed static validation/iu);
  assert.match(prompts[1], /summary must use the item content language en/iu);
});

test('background worker pauses without retrying when review identifies missing evidence', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-evidence-pause-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let modelCalls = 0;
  const result = await runBackgroundUpdate(dataDir, 'session-evidence-pause', {
    runCommand: async argv => {
      if (argv[1] === 'prepare') return {
        outcome: 'generate_and_review', prompt: 'Update contract', previousAttemptErrors: [],
        existingPlan: { updates: [] }, availableStatuses: ['Todo'], statusRules: null,
        boundItems: [{ itemId: 'PVTI_1', contentLanguage: 'en' }], referenceLinks: [],
        context: [{ sequence: 1, kind: 'user', text: 'Implement the parser.' }],
        useThreadHistory: false, promptNames: ['update'], planningDate: '2026-08-30',
        model: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
        reviewModel: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' }
      };
      if (argv[1] === 'stage') return { accepted: true, plan: { updates: [] }, staticReport: { valid: true, errors: [] } };
      if (argv[1] === 'apply') return { applied: false, awaitingEvidence: true, errors: ['Implementation evidence is missing.'] };
      throw new Error(`Unexpected command: ${argv.join(' ')}`);
    },
    invokeModel: async input => {
      modelCalls++;
      if ('updates' in input.schema.properties) return { updates: [] };
      return {
        decision: 'reject', reason: 'The requirement has no implementation evidence yet.',
        journalCoverage: [{ sequence: 1, disposition: 'missing', itemIds: [], reason: 'No verified result supports an update.' }]
      };
    }
  });
  assert.equal(result.outcome, 'awaiting_evidence');
  assert.equal(modelCalls, 2);
});

test('background worker reviews every journal entry before accepting an unchanged pending plan', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-noop-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  let modelCalls = 0;
  const runCommand = async argv => {
    calls.push(argv.slice(0, 2).join(' '));
    if (argv[1] === 'prepare') {
      return {
        outcome: 'generate_and_review',
        prompt: 'Update contract',
        existingPlan: { updates: [{ itemId: 'PVTI_1', summary: 'Queued work.' }] },
        availableStatuses: ['Todo'],
        boundItems: [{ itemId: 'PVTI_1', title: 'Parser' }],
        context: [{ sequence: 2, kind: 'user', text: 'Check.' }],
        useThreadHistory: false,
        promptNames: ['update'],
        planningDate: '2026-08-30',
        model: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
        reviewModel: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' }
      };
    }
    if (argv[1] === 'stage') {
      const plan = JSON.parse(await fs.readFile(argv[argv.indexOf('--plan') + 1], 'utf8'));
      assert.deepEqual(plan, { updates: [{ itemId: 'PVTI_1', summary: 'Queued work.' }] });
      return { accepted: true, plan, staticReport: { valid: true, errors: [] } };
    }
    if (argv[1] === 'apply') return { planned: true, queuedUpdates: 1, queuedOperations: 1 };
    throw new Error(`Unexpected command: ${argv.join(' ')}`);
  };
  const invokeModel = async input => {
    modelCalls++;
    if ('updates' in input.schema.properties) {
      return { updates: [{ itemId: 'PVTI_1', summary: 'Queued work.' }] };
    }
    return {
      decision: 'approve',
      reason: 'The new journal entry is only a question.',
      journalCoverage: [{
        sequence: 2,
        disposition: 'irrelevant',
        itemIds: [],
        reason: 'The check request contains no durable project requirement or result.'
      }]
    };
  };

  const result = await runBackgroundUpdate(dataDir, 'session-1', { runCommand, invokeModel });
  assert.equal(result.planned, true);
  assert.equal(modelCalls, 2);
  assert.deepEqual(calls, ['update prepare', 'update stage', 'update apply']);
});

test('background worker resumes a persisted staged plan with review only', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-resume-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  let modelCalls = 0;
  const runCommand = async argv => {
    calls.push(argv.slice(0, 2).join(' '));
    if (argv[1] === 'prepare') return {
      outcome: 'review_staged',
      stagedPlan: { updates: [{ itemId: 'PVTI_1', summary: 'Parser complete.' }] },
      staticReport: { valid: true, errors: [] },
      existingPlan: { updates: [] },
      statusRules: null,
      context: [{ sequence: 1, kind: 'assistant', text: 'Parser complete.' }],
      promptNames: ['update'],
      referenceLinks: [],
      boundItems: [{ itemId: 'PVTI_1' }],
      planningDate: '2026-08-30',
      useThreadHistory: false,
      reviewModel: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' }
    };
    if (argv[1] === 'apply') return { planned: true, queuedUpdates: 1 };
    throw new Error(`Unexpected command: ${argv.join(' ')}`);
  };
  const result = await runBackgroundUpdate(dataDir, 'session-1', {
    runCommand,
    invokeModel: async input => {
      modelCalls++;
      assert.equal('updates' in input.schema.properties, false);
      return {
        decision: 'approve',
        reason: 'The staged plan covers the completed work.',
        journalCoverage: [{
          sequence: 1,
          disposition: 'included',
          itemIds: ['PVTI_1'],
          reason: 'The staged summary represents the completed parser work.'
        }]
      };
    }
  });
  assert.equal(result.planned, true);
  assert.equal(modelCalls, 1);
  assert.deepEqual(calls, ['update prepare', 'update apply']);
});

test('background worker resumes an approved phase without another model call', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-reviewed-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  let prepareCount = 0;
  const result = await runBackgroundUpdate(dataDir, 'session-1', {
    runCommand: async argv => {
      calls.push(argv.slice(0, 2).join(' '));
      if (argv[1] === 'prepare') {
        prepareCount++;
        return prepareCount === 1
          ? { outcome: 'resume_apply' }
          : { outcome: 'noop', reason: 'The recovered batch is complete.' };
      }
      if (argv[1] === 'apply') return { planned: true, queuedUpdates: 1 };
      throw new Error(`Unexpected command: ${argv.join(' ')}`);
    },
    invokeModel: async () => { throw new Error('No model call expected.'); }
  });
  assert.equal(result.planned, true);
  assert.deepEqual(calls, ['update prepare', 'update apply']);
});

test('SessionStart background entry detects and resumes a persisted active transaction', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-hook-resume-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { state } = await openSession(dataDir, 'session-resume');
  bindItem(state, { itemId: 'PVTI_1', title: 'Parser' });
  appendJournal(state, { kind: 'assistant', turnId: 'turn-1', text: 'Parser implementation is complete.' });
  beginUpdate(state, 'run-interrupted');
  await writeState(dataDir, state);
  const calls = [];
  const outcome = await runHook({
    input: { session_id: 'session-resume', source: 'resume' },
    dataDir,
    runUpdate: async (actualDataDir, sessionId, options) => {
      calls.push({ actualDataDir, sessionId, options });
      return { outcome: 'resumed' };
    }
  });
  assert.deepEqual(outcome, { outcome: 'resumed' });
  assert.deepEqual(calls, [{
    actualDataDir: dataDir,
    sessionId: 'session-resume',
    options: { reconcileBindings: true }
  }]);
});

test('background worker generates missing status rules before a durable status intent', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-rules-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  let prepares = 0;
  const result = await runBackgroundUpdate(dataDir, 'session-rules', {
    runCommand: async argv => {
      calls.push(argv[0]);
      if (argv[0] === 'update') {
        prepares++;
        return prepares === 1 ? {
          outcome: 'status_rules_required',
          model: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
          generation: {
            prompt: 'prompts/status-rules.md', availableStatuses: ['Todo', 'Done'],
            defaultStatus: 'Todo', terminalStatuses: ['Done'],
            statusRoles: { queued: 'Todo', active: '', review: '', blocked: '', completed: 'Done' }
          }
        } : { outcome: 'noop', reason: 'Rules are ready.' };
      }
      if (argv[0] === 'check') {
        assert.ok(argv.includes('--rules-file'));
        return { statusRuleGeneration: { required: false } };
      }
      throw new Error(`Unexpected command: ${argv.join(' ')}`);
    },
    invokeModel: async input => {
      assert.deepEqual(input.schema.required, ['statuses', 'transitions']);
      return {
        statuses: [
          { name: 'Todo', enterWhen: 'Work is queued and has not started.', doNotEnterWhen: 'Work is actively being implemented.' },
          { name: 'Done', enterWhen: 'All required work and verification are complete.', doNotEnterWhen: 'Required work or verification remains.' }
        ],
        transitions: [{
          from: 'Todo', to: 'Done', when: 'All required work and verification are complete.',
          doNotApplyWhen: 'Required work or verification remains incomplete.'
        }]
      };
    }
  });
  assert.equal(result.outcome, 'noop');
  assert.deepEqual(calls, ['update', 'check', 'update']);
});

test('background worker reconciles an attempted submission before planning newer context', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-reconcile-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  let prepareCount = 0;
  const runCommand = async argv => {
    calls.push(argv.slice(0, 2).join(' '));
    if (argv[1] === 'prepare') {
      prepareCount++;
      return prepareCount === 1
        ? { outcome: 'submission_unverified' }
        : { outcome: 'noop', reason: 'No context remains.' };
    }
    if (argv[1] === 'submit') return { submitted: true, verified: true };
    throw new Error(`Unexpected command: ${argv.join(' ')}`);
  };

  const result = await runBackgroundUpdate(dataDir, 'session-1', {
    runCommand,
    invokeModel: async () => { throw new Error('No model call expected.'); }
  });
  assert.equal(result.outcome, 'noop');
  assert.deepEqual(calls, ['update prepare', 'update submit', 'update prepare']);
});

test('background worker retains an attempted submission when reconciliation is inconclusive', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-unverified-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const runCommand = async argv => {
    calls.push(argv.slice(0, 2).join(' '));
    if (argv[1] === 'prepare') return { outcome: 'submission_unverified' };
    if (argv[1] === 'submit') return { submitted: false, verified: false, conflicts: 1 };
    throw new Error(`Unexpected command: ${argv.join(' ')}`);
  };

  const result = await runBackgroundUpdate(dataDir, 'session-1', { runCommand });
  assert.equal(result.outcome, 'submission_unverified');
  assert.equal(result.reconciliation.conflicts, 1);
  assert.deepEqual(calls, ['update prepare', 'update submit']);
});

test('background worker stops immediately after terminal bindings are released', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-background-unbound-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let calls = 0;

  const result = await runBackgroundUpdate(dataDir, 'session-unbound', {
    runCommand: async argv => {
      calls++;
      assert.deepEqual(argv.slice(0, 2), ['update', 'prepare']);
      assert.equal(argv.includes('--reconcile-bindings'), true);
      return { outcome: 'paused_no_bindings', reason: 'All terminal bindings were verified and released.' };
    },
    invokeModel: async () => { throw new Error('No model call expected.'); },
    reconcileBindings: true
  });

  assert.equal(result.outcome, 'paused_no_bindings');
  assert.equal(calls, 1);
});
