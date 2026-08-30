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
    statusFieldName: 'Status',
    updateFieldName: 'Update',
    kanban: { defaultStatus: 'Backlog', terminalStatuses: ['Shipped'] },
    defaultRepository: 'octocat/todos'
  };
  await fs.writeFile(configFile, JSON.stringify(config));
  await updateProjectMetadata(directory, config, {
    availableStatuses: ['Backlog', 'Doing', 'Shipped'],
    statusRules: {
      fingerprint: 'test-fingerprint',
      generatedAt: '2026-08-30T00:00:00.000Z',
      statuses: [{
        name: 'Backlog',
        enterWhen: 'Work is accepted but no implementation has started.',
        doNotEnterWhen: 'Do not use when implementation evidence already exists.'
      }, {
        name: 'Doing',
        enterWhen: 'Implementation has started and durable work evidence exists.',
        doNotEnterWhen: 'Do not use for discussion, intent, or unstarted plans.'
      }, {
        name: 'Shipped',
        enterWhen: 'Required work and verification are complete and released.',
        doNotEnterWhen: 'Do not use while implementation or verification remains.'
      }],
      transitions: [{
        from: 'Backlog',
        to: 'Doing',
        when: 'Move when repository evidence shows implementation has started.',
        doNotApplyWhen: 'Do not move when the thread contains only plans or questions.'
      }, {
        from: 'Doing',
        to: 'Shipped',
        when: 'Move when required implementation and verification are complete.',
        doNotApplyWhen: 'Do not move while required work or verification is incomplete.'
      }]
    },
    creationPolicy: { projectVisibility: 'private', repositoryVisibility: 'public', route: 'draft' }
  });
  const previous = process.env.MINEPROGRESS_CONFIG;
  process.env.MINEPROGRESS_CONFIG = configFile;
  t.after(() => { if (previous === undefined) delete process.env.MINEPROGRESS_CONFIG; else process.env.MINEPROGRESS_CONFIG = previous; });
  const result = await run(['status', '--session', 's1', '--data-dir', directory]);
  assert.equal(result.creationPolicyLine, 'Creation route: Project private, Issue repository octocat/todos (public) -> draft.');
  assert.equal(result.kanbanStatusLine, 'Kanban statuses: Backlog, Doing, Shipped.');
  assert.equal(result.kanbanPolicyLine, 'Kanban policy: default Backlog; terminal Shipped.');
  assert.equal(result.statusRules.length, 5);
  assert.ok(result.statusRules.some(line => line.startsWith('Transition Doing -> Shipped:')));
  assert.equal(result.unresolvedCount, 0);
});
