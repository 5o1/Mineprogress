import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProjectMetadata, updateProjectMetadata } from '../scripts/lib/metadata.mjs';

const config = { ownerType: 'user', owner: 'octocat', projectNumber: 1, creation: { repository: 'octocat/todos' } };

test('Project metadata cache is global rather than thread-scoped', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-metadata-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await updateProjectMetadata(dataDir, config, {
    availableStatuses: ['Backlog', 'Building', 'Shipped'],
    creationPolicy: { projectVisibility: 'private', repositoryVisibility: 'public', route: 'draft' }
  });
  const metadata = await readProjectMetadata(dataDir, { ...config });
  assert.deepEqual(metadata.availableStatuses, ['Backlog', 'Building', 'Shipped']);
  assert.equal(metadata.creationPolicy.route, 'draft');
  assert.ok(metadata.checkedAt);
  const legacy = await readProjectMetadata(dataDir, {
    ownerType: 'user', owner: 'octocat', projectNumber: 1, defaultRepository: 'octocat/todos'
  });
  assert.equal(legacy.creationPolicy.route, 'draft');
});
