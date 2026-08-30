import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../scripts/mineprogress.mjs';
import { updateProjectMetadata } from '../scripts/lib/metadata.mjs';

test('status is offline and reports global route and discovered statuses as separate lines', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-status-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  const config = {
    owner: 'octocat',
    ownerType: 'user',
    projectNumber: 1,
    defaultRepository: 'octocat/todos',
    statusFieldName: 'Status',
    updateFieldName: 'Update',
    kanban: { defaultStatus: 'Backlog', terminalStatuses: ['Shipped'] }
  };
  await fs.writeFile(configFile, JSON.stringify(config));
  await updateProjectMetadata(directory, config, {
    availableStatuses: ['Backlog', 'Doing', 'Shipped'],
    creationPolicy: { projectVisibility: 'private', repositoryVisibility: 'public', route: 'draft' }
  });
  const previous = process.env.MINEPROGRESS_CONFIG;
  process.env.MINEPROGRESS_CONFIG = configFile;
  t.after(() => { if (previous === undefined) delete process.env.MINEPROGRESS_CONFIG; else process.env.MINEPROGRESS_CONFIG = previous; });
  const result = await run(['status', '--session', 's1', '--data-dir', directory]);
  assert.equal(result.creationPolicyLine, 'Creation route: Project private, repository public -> draft.');
  assert.equal(result.kanbanStatusLine, 'Kanban statuses: Backlog, Doing, Shipped.');
  assert.equal(result.kanbanPolicyLine, 'Kanban policy: default Backlog; terminal Shipped.');
  assert.equal(result.unresolvedCount, 0);
});
