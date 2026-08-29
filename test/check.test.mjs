import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestBindings } from '../scripts/lib/check.mjs';

test('check suggests candidates without mutating bindings', () => {
  const bound = [{ itemId: 'missing', title: 'Gone' }, { itemId: 'done', title: 'Done item' }];
  const project = [
    { itemId: 'done', title: 'Done item', status: 'Done', archived: false },
    { itemId: 'todo', title: 'Next item', status: 'Todo', archived: false },
    { itemId: 'archived', title: 'Old', status: 'Todo', archived: true }
  ];
  const result = suggestBindings(bound, project, { availableStatuses: ['Todo', 'Done'], terminalStatuses: ['Done'] });
  assert.deepEqual(result.suggestedAdd.map(item => item.itemId), ['todo']);
  assert.deepEqual(result.suggestedRemove.map(item => item.itemId), ['missing', 'done']);
  assert.equal(bound.length, 2);
});
