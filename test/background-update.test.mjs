import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBackgroundUpdate } from '../scripts/background-update.mjs';

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
    boundItems: [{ itemId: 'PVTI_1', title: 'Parser' }],
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
      assert.deepEqual(review, { decision: 'approve', reason: 'Relevant and redacted.' });
      return { planned: true, queuedUpdates: 1 };
    }
    throw new Error(`Unexpected command: ${argv.join(' ')}`);
  };
  const invokeModel = async input => {
    prompts.push(input.prompt);
    forks.push(input.forkSessionId);
    if ('updates' in input.schema.properties) {
      assert.deepEqual(input.schema.properties.updates.items.required, ['itemId', 'status', 'summary', 'body', 'comment']);
      return { updates: [{ itemId: 'PVTI_1', status: 'Done', summary: 'Parser completed.', body: null, comment: null }] };
    }
    return { decision: 'approve', reason: 'Relevant and redacted.' };
  };

  const result = await runBackgroundUpdate(dataDir, 'session-1', { runCommand, invokeModel });
  assert.equal(result.planned, true);
  assert.deepEqual(calls, ['update prepare', 'update stage', 'update apply']);
  assert.equal(calls.includes('update submit'), false);
  assert.equal(prompts.length, 2);
  assert.deepEqual(forks, ['session-1', 'session-1']);
  assert.match(prompts[0], /Parser is complete/);
  assert.match(prompts[0], /messages from before Mineprogress was installed/);
  assert.match(prompts[1], /proposedPlan/);
  assert.match(prompts[1], /Reviewer checklist/);
});
