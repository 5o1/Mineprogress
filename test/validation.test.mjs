import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, validateReview } from '../scripts/lib/validation.mjs';

const options = {
  boundItemIds: ['PVTI_1'],
  allowedStatuses: ['Todo', 'In progress', 'Done', 'Blocked'],
  maxCharacters: 100,
  maxWords: 20
};

test('static plan validation accepts a bound concise update and approved no-op', () => {
  assert.equal(validatePlan({ updates: [{ itemId: 'PVTI_1', status: 'Done', summary: 'Parser implemented and tested.' }] }, options).valid, true);
  assert.equal(validatePlan({ updates: [] }, options).valid, true);
});

test('static plan validation rejects unbound writes, extra fields, and personal data', () => {
  const report = validatePlan({ updates: [{ itemId: 'PVTI_2', title: 'Changed', summary: 'Email me@example.com' }] }, options);
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /not bound|forbidden field|email/);
});

test('review output cannot rewrite the plan', () => {
  assert.equal(validateReview({ decision: 'approve', reason: 'Relevant and redacted.' }).valid, true);
  assert.equal(validateReview({ decision: 'reject', reason: 'Too broad.', replacement: {} }).valid, false);
});
