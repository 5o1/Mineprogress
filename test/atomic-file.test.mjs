import test from 'node:test';
import assert from 'node:assert/strict';
import { renameWithRetry } from '../scripts/lib/atomic-file.mjs';

test('atomic rename retries transient Windows file contention', async () => {
  const waits = [];
  let calls = 0;
  await renameWithRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
  }, 'source', 'destination', {
    delays: [5, 10],
    wait: async delay => waits.push(delay)
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 10]);
});

test('atomic rename does not retry unrelated failures', async () => {
  let calls = 0;
  await assert.rejects(renameWithRetry(async () => {
    calls++;
    throw Object.assign(new Error('invalid'), { code: 'EINVAL' });
  }, 'source', 'destination', { wait: async () => {} }), { code: 'EINVAL' });
  assert.equal(calls, 1);
});
