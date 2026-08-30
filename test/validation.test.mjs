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

test('managed bodies require chronological Historical Progress segments', () => {
  const bodyOptions = {
    ...options,
    boundItems: [{ itemId: 'PVTI_1', contentType: 'issue' }]
  };
  const validBody = '<!-- mineprogress:managed:start -->\n## Context\nParser.\n## Historical Progress\n### 2026-08-29 — Design\n#### Requirements\n- Parse.\n#### Results\n- Designed.\n### 2026-08-30 — Delivery\n#### Requirements\n- Test.\n#### Results\n- Passed.\n<!-- mineprogress:managed:end -->';
  assert.equal(validatePlan({ updates: [{ itemId: 'PVTI_1', body: validBody }] }, bodyOptions).valid, true);
  const manualOptions = {
    ...bodyOptions,
    boundItems: [{ itemId: 'PVTI_1', contentType: 'issue', body: `Manual preface.\n\n${validBody}\n\nManual appendix.` }]
  };
  assert.equal(validatePlan({ updates: [{
    itemId: 'PVTI_1', body: `Changed preface.\n\n${validBody}\n\nManual appendix.`
  }] }, manualOptions).valid, false);
  const invalidBody = validBody
    .replace('## Historical Progress', '## Current Progress')
    .replace('### 2026-08-29 — Design', '### 2026-08-31 — Design');
  const report = validatePlan({ updates: [{ itemId: 'PVTI_1', body: invalidBody }] }, bodyOptions);
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /Historical Progress|Current Progress|chronological/);
});

test('review output cannot rewrite the plan', () => {
  assert.equal(validateReview({ decision: 'approve', reason: 'Relevant and redacted.' }).valid, true);
  assert.equal(validateReview({ decision: 'reject', reason: 'Too broad.', replacement: {} }).valid, false);
});
