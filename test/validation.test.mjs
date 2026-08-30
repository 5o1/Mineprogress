import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, validateReview } from '../scripts/lib/validation.mjs';

const options = {
  boundItemIds: ['PVTI_1'],
  allowedStatuses: ['Todo', 'In progress', 'Done', 'Blocked'],
  maxCharacters: 100,
  maxWords: 20
};

const proposal = `<!-- mineprogress:managed:start -->
## Abstract
Build a deterministic parser.
## Background and Significance
Input handling needs a reliable implementation.
## Problem Statement
Existing parsing behavior is incomplete.
## Objectives
Implement and verify the parser.
## Scope and Research Questions
Cover supported input syntax and error cases.
## Methodology and Technical Approach
Use a small parser with deterministic native tests.
## Expected Deliverables and Evaluation Criteria
Deliver source code with passing tests.
## Work Plan and Milestones
Design, implement, test, and review.
## Risks, Constraints, and Security
Reject malformed input and avoid sensitive data.
<!-- mineprogress:managed:end -->`;

const progress = `## Progress Update — 2026-08-30 — Parser
### Requirements
- Parse supported input.
### Results
- Parser tests pass.`;

test('static plan validation accepts a bound concise update and approved no-op', () => {
  assert.equal(validatePlan({ updates: [{ itemId: 'PVTI_1', status: 'Done', summary: 'Parser implemented and tested.' }] }, options).valid, true);
  assert.equal(validatePlan({ updates: [] }, options).valid, true);
});

test('static plan validation permits only generated status transitions', () => {
  const transitionOptions = {
    ...options,
    boundItems: [{ itemId: 'PVTI_1', status: 'In progress' }],
    statusRules: {
      transitions: [{
        from: 'In progress',
        to: 'Blocked',
        when: 'A concrete external dependency prevents further implementation.',
        doNotApplyWhen: 'Do not use for ordinary questions or unfinished local work.'
      }]
    }
  };
  assert.equal(validatePlan({
    updates: [{ itemId: 'PVTI_1', status: 'Blocked' }]
  }, transitionOptions).valid, true);
  const report = validatePlan({
    updates: [{ itemId: 'PVTI_1', status: 'Done' }]
  }, transitionOptions);
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /no generated transition rule from In progress to Done/);
});

test('static plan validation rejects unbound writes, extra fields, and personal data', () => {
  const report = validatePlan({ updates: [{ itemId: 'PVTI_2', title: 'Changed', summary: 'Email me@example.com' }] }, options);
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /not bound|forbidden field|email/);
});

test('static plan validation rejects update-pipeline narration', () => {
  const report = validatePlan({
    updates: [{
      itemId: 'PVTI_1',
      summary: 'Generation attempt 2 passed static checks and is awaiting reviewer approval.'
    }]
  }, options);
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /control-plane narration/);
});

test('static plan validation enforces each item content language marker', () => {
  const englishItem = {
    ...options,
    boundItems: [{ itemId: 'PVTI_1', contentLanguage: 'en' }]
  };
  const chineseItem = {
    ...options,
    boundItems: [{ itemId: 'PVTI_1', contentLanguage: 'zh-cn' }]
  };
  assert.match(validatePlan({
    updates: [{ itemId: 'PVTI_1', summary: '重构已经完成。' }]
  }, englishItem).errors.join(' '), /content language en/);
  assert.match(validatePlan({
    updates: [{ itemId: 'PVTI_1', summary: 'The refactor is complete.' }]
  }, chineseItem).errors.join(' '), /content language zh-cn/);
});

test('only a writable created item accepts the one-time academic proposal', () => {
  const writable = {
    ...options,
    boundItems: [{ itemId: 'PVTI_1', contentType: 'issue', proposalWritable: true, body: '' }]
  };
  assert.equal(validatePlan({ updates: [{ itemId: 'PVTI_1', body: proposal }] }, writable).valid, true);

  const locked = {
    ...options,
    boundItems: [{ itemId: 'PVTI_1', contentType: 'issue', proposalWritable: false, body: proposal }]
  };
  const report = validatePlan({ updates: [{ itemId: 'PVTI_1', body: `${proposal}\nChanged.` }] }, locked);
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /immutable/);
});

test('Issue history uses comments while Draft history is exact-prefix append-only', () => {
  const issueOptions = {
    ...options,
    boundItems: [{ itemId: 'PVTI_1', contentType: 'issue', proposalWritable: false, body: proposal }]
  };
  assert.equal(validatePlan({ updates: [{ itemId: 'PVTI_1', comment: progress }] }, issueOptions).valid, true);

  const draftOptions = {
    ...options,
    boundItems: [{ itemId: 'PVTI_1', contentType: 'draft', proposalWritable: false, body: proposal }]
  };
  assert.equal(validatePlan({ updates: [{ itemId: 'PVTI_1', body: `${proposal}\n\n${progress}` }] }, draftOptions).valid, true);
  const altered = validatePlan({ updates: [{ itemId: 'PVTI_1', body: `${proposal.replace('deterministic', 'fast')}\n\n${progress}` }] }, draftOptions);
  assert.equal(altered.valid, false);
  assert.match(altered.errors.join(' '), /append|outside/);
});

test('queued proposals stay exact and queued changelogs may only grow by suffix', () => {
  const existingPlan = { updates: [{ itemId: 'PVTI_1', body: proposal, comment: progress }] };
  const pendingOptions = {
    ...options,
    boundItems: [{
      itemId: 'PVTI_1', contentType: 'issue', proposalWritable: false, pendingBodyKind: 'proposalBody', body: ''
    }],
    existingPlan
  };
  const appendedComment = `${progress}\n\n## Progress Update — 2026-08-31 — Review\n### Requirements\n- Review output.\n### Results\n- Review passed.`;
  assert.equal(validatePlan({ updates: [{ itemId: 'PVTI_1', body: proposal, comment: appendedComment }] }, pendingOptions).valid, true);
  const changed = validatePlan({ updates: [{ itemId: 'PVTI_1', body: proposal.replace('parser', 'compiler'), comment: progress }] }, pendingOptions);
  assert.equal(changed.valid, false);
  assert.match(changed.errors.join(' '), /immutable|pending/);
});

test('review output cannot rewrite the plan', () => {
  assert.equal(validateReview({ decision: 'approve', reason: 'Relevant and redacted.' }).valid, true);
  assert.equal(validateReview({ decision: 'reject', reason: 'Too broad.', replacement: {} }).valid, false);
});

test('review coverage must classify every journal entry and link included evidence to a plan delta', () => {
  const reviewOptions = {
    journalEvents: [
      { sequence: 10, text: 'Implement parser.' },
      { sequence: 11, text: 'What time is it?' }
    ],
    proposedPlan: { updates: [{ itemId: 'PVTI_1', summary: 'Parser implemented.' }] },
    existingPlan: { updates: [] },
    boundItemIds: ['PVTI_1'],
    requireCoverage: true
  };
  const approved = validateReview({
    decision: 'approve',
    reason: 'All journal evidence is classified.',
    journalCoverage: [{
      sequence: 10,
      disposition: 'included',
      itemIds: ['PVTI_1'],
      reason: 'The implementation request is represented in the changed summary.'
    }, {
      sequence: 11,
      disposition: 'irrelevant',
      itemIds: [],
      reason: 'The time question contains no durable project requirement or result.'
    }]
  }, reviewOptions);
  assert.equal(approved.valid, true);

  const incomplete = validateReview({
    decision: 'approve',
    reason: 'One event was accidentally omitted.',
    journalCoverage: [{
      sequence: 10,
      disposition: 'included',
      itemIds: ['PVTI_1'],
      reason: 'The implementation request is represented in the changed summary.'
    }]
  }, reviewOptions);
  assert.equal(incomplete.valid, false);
  assert.match(incomplete.errors.join(' '), /every journal entry/);

  const missing = validateReview({
    decision: 'approve',
    reason: 'A durable event is not represented.',
    journalCoverage: [{
      sequence: 10,
      disposition: 'missing',
      itemIds: [],
      reason: 'The implementation requirement is absent from the proposed plan.'
    }, {
      sequence: 11,
      disposition: 'irrelevant',
      itemIds: [],
      reason: 'The time question contains no durable project requirement or result.'
    }]
  }, reviewOptions);
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join(' '), /missing from an approved plan/);
});
