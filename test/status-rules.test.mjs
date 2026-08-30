import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusFingerprint,
  statusRuleLines,
  storedStatusRules,
  validateStatusRules
} from '../src/backend/status-rules.mjs';

const statuses = ['Todo', 'In Progress', 'Review', 'Blocked', 'Done'];
const rules = {
  statuses: statuses.map(name => ({
    name,
    enterWhen: `Enter ${name} only when its observable work condition is satisfied.`,
    doNotEnterWhen: `Do not enter ${name} from conversation intent or internal agent activity alone.`
  })),
  transitions: [
    ['Todo', 'In Progress'],
    ['In Progress', 'Review'],
    ['In Progress', 'Blocked'],
    ['Blocked', 'In Progress'],
    ['Review', 'In Progress'],
    ['Review', 'Done'],
    ['Done', 'In Progress']
  ].map(([from, to]) => ({
    from,
    to,
    when: `Move from ${from} to ${to} only when durable evidence supports the target condition.`,
    doNotApplyWhen: 'Do not move for plans, questions, model narration, or unverified claims.'
  }))
};

test('status rules require explicit boundaries and make every status reachable', () => {
  assert.deepEqual(validateStatusRules(rules, { statuses, defaultStatus: 'Todo' }), {
    valid: true,
    errors: []
  });

  const unreachable = structuredClone(rules);
  unreachable.transitions = unreachable.transitions.filter(rule => rule.to !== 'Blocked');
  const report = validateStatusRules(unreachable, { statuses, defaultStatus: 'Todo' });
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /unreachable: Blocked/);
});

test('status rules reject missing statuses, vague boundaries, and unknown transitions', () => {
  const invalid = structuredClone(rules);
  invalid.statuses.pop();
  invalid.statuses[0].enterWhen = 'work starts';
  invalid.transitions.push({
    from: 'Todo',
    to: 'Missing',
    when: 'Move only when durable evidence supports the target condition.',
    doNotApplyWhen: 'Do not move when the evidence is incomplete or ambiguous.'
  });
  const report = validateStatusRules(invalid, { statuses, defaultStatus: 'Todo' });
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /every available status exactly once/);
  assert.match(report.errors.join(' '), /12-500 character boundary/);
  assert.match(report.errors.join(' '), /exact available statuses/);
});

test('status fingerprints ignore ordering and visualized rules include every boundary', () => {
  assert.equal(statusFingerprint(statuses), statusFingerprint([...statuses].reverse()));
  assert.notEqual(statusFingerprint(statuses), statusFingerprint([...statuses, 'Cancelled']));

  const stored = storedStatusRules(rules, statuses);
  const lines = statusRuleLines(stored);
  assert.equal(lines.length, rules.statuses.length + rules.transitions.length);
  assert.ok(lines.some(line => line.startsWith('Status Blocked:')));
  assert.ok(lines.some(line => line.startsWith('Transition Review -> Done:')));
});
