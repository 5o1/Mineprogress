import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusFingerprint,
  statusRuleLines,
  storedStatusRules,
  validateStatusRules
} from '../src/backend/status-rules.mjs';
import { statusFixture } from './status-fixture.mjs';

const STATUS = statusFixture();
const statuses = [STATUS.queued, STATUS.active, STATUS.review, STATUS.blocked, STATUS.terminal];
const rules = {
  statuses: statuses.map(name => ({
    name,
    enterWhen: `Enter ${name} only when its observable work condition is satisfied.`,
    doNotEnterWhen: `Do not enter ${name} from conversation intent or internal agent activity alone.`
  })),
  transitions: [
    [STATUS.queued, STATUS.active],
    [STATUS.active, STATUS.review],
    [STATUS.active, STATUS.blocked],
    [STATUS.blocked, STATUS.active],
    [STATUS.review, STATUS.active],
    [STATUS.review, STATUS.terminal],
    [STATUS.terminal, STATUS.active]
  ].map(([from, to]) => ({
    from,
    to,
    when: `Move from ${from} to ${to} only when durable evidence supports the target condition.`,
    doNotApplyWhen: 'Do not move for plans, questions, model narration, or unverified claims.'
  }))
};

test('status rules require explicit boundaries and make every status reachable', () => {
  assert.deepEqual(validateStatusRules(rules, { statuses, defaultStatus: STATUS.queued }), {
    valid: true,
    errors: []
  });

  const unreachable = structuredClone(rules);
  unreachable.transitions = unreachable.transitions.filter(rule => rule.to !== STATUS.blocked);
  const report = validateStatusRules(unreachable, { statuses, defaultStatus: STATUS.queued });
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), new RegExp(`unreachable: ${STATUS.blocked}`, 'u'));
});

test('status rules reject missing statuses, vague boundaries, and unknown transitions', () => {
  const invalid = structuredClone(rules);
  invalid.statuses.pop();
  invalid.statuses[0].enterWhen = 'work starts';
  invalid.transitions.push({
    from: STATUS.queued,
    to: 'Missing',
    when: 'Move only when durable evidence supports the target condition.',
    doNotApplyWhen: 'Do not move when the evidence is incomplete or ambiguous.'
  });
  const report = validateStatusRules(invalid, { statuses, defaultStatus: STATUS.queued });
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /every available status exactly once/);
  assert.match(report.errors.join(' '), /12-500 character boundary/);
  assert.match(report.errors.join(' '), /exact available statuses/);
});

test('status fingerprints ignore ordering and visualized rules include every boundary', () => {
  assert.equal(statusFingerprint(statuses), statusFingerprint([...statuses].reverse()));
  assert.notEqual(statusFingerprint(statuses), statusFingerprint([...statuses, `extra-${STATUS.terminal}`]));

  const stored = storedStatusRules(rules, statuses);
  const lines = statusRuleLines(stored);
  assert.equal(lines.length, rules.statuses.length + rules.transitions.length);
  assert.ok(lines.some(line => line.startsWith(`Status ${STATUS.blocked}:`)));
  assert.ok(lines.some(line => line.startsWith(`Transition ${STATUS.review} -> ${STATUS.terminal}:`)));
});
