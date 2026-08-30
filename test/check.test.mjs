import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestBindings } from '../scripts/lib/check.mjs';
import { statusFixture } from './status-fixture.mjs';

test('check suggests candidates without mutating bindings', () => {
  const statuses = statusFixture();
  const bound = [{ itemId: 'missing', title: 'Gone' }, { itemId: 'done', title: 'Done item' }];
  const project = [
    { itemId: 'done', title: 'Done item', status: statuses.terminal, archived: false },
    { itemId: 'todo', title: 'Next item', status: statuses.queued, archived: false },
    { itemId: 'archived', title: 'Old', status: statuses.queued, archived: true }
  ];
  const result = suggestBindings(bound, project, {
    availableStatuses: [statuses.queued, statuses.terminal], terminalStatuses: [statuses.terminal]
  });
  assert.deepEqual(result.suggestedAdd.map(item => item.itemId), ['todo']);
  assert.deepEqual(result.suggestedRemove.map(item => item.itemId), ['missing', 'done']);
  assert.equal(bound.length, 2);
});
