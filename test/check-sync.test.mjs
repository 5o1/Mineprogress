import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeBackend } from '../src/backend/application.mjs';
import { bindItem, openSession, writeState } from '../src/backend/state.mjs';
import { readProjectMetadata } from '../src/backend/metadata.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('check synchronizes remote statuses into private config before suggesting bindings', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-check-sync-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const configPath = path.join(dataDir, 'config.json');
  await fs.writeFile(configPath, `${JSON.stringify({
    owner: 'octocat', ownerType: 'user', projectNumber: 1,
    statusFieldName: 'Status', updateFieldName: 'Update',
    kanban: {
      defaultStatus: 'Todo',
      terminalStatuses: ['Done'],
      statusRoles: {
        queued: 'Todo', active: 'Doing', review: 'Review', blocked: '', completed: 'Done'
      }
    }
  }, null, 2)}\n`);
  const { state } = await openSession(dataDir, 'session-check');
  bindItem(state, { itemId: 'BOUND', title: 'Bound item' });
  await writeState(dataDir, state);
  let statuses = ['Backlog', 'Doing', 'In review', 'Blocked', 'Completed'];
  const client = async query => {
    if (!query.includes('query($login')) throw new Error('Unexpected GitHub request.');
    return { user: { projectV2: {
      id: 'PVT_1', title: 'Tasks', public: true,
      repositories: { totalCount: 0, nodes: [] },
      fields: { nodes: [
        { id: 'STATUS', name: 'Status', options: statuses.map((name, index) => ({ id: `S${index}`, name })) },
        { id: 'UPDATE', name: 'Update' }
      ] },
      items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        id: 'CANDIDATE', isArchived: false,
        content: { __typename: 'Issue', id: 'I_1', title: 'Candidate', body: '', state: 'OPEN' },
        fieldValues: { nodes: [{ name: 'Doing', field: { name: 'Status' } }] }
      }] }
    } }, organization: null };
  };
  const result = await executeBackend({
    command: 'check', options: { session: 'session-check' }
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    githubClient: async () => client
  });
  assert.deepEqual(result.availableStatuses, statuses);
  assert.equal(result.defaultStatus, 'Backlog');
  assert.deepEqual(result.terminalStatuses, ['Completed']);
  assert.deepEqual(result.statusRoles, {
    queued: 'Backlog', active: 'Doing', review: 'In review', blocked: 'Blocked', completed: 'Completed'
  });
  assert.deepEqual(result.suggestedAdd.map(item => item.itemId), ['CANDIDATE']);
  assert.ok(result.configurationChanges.length > 0);
  assert.equal(result.statusRuleGeneration.required, true);
  assert.deepEqual(result.statusRuleGeneration.statusRoles, result.statusRoles);

  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(saved.kanban.statusRoles, result.statusRoles);
  let metadata = await readProjectMetadata(dataDir, saved);
  assert.deepEqual(metadata.availableStatuses, statuses);
  assert.deepEqual(metadata.statusRoles, result.statusRoles);
  assert.equal(metadata.statusRules, null);

  const rulesPath = path.join(dataDir, 'status-rules.json');
  const rules = {
    statuses: statuses.map(name => ({
      name,
      enterWhen: `Enter ${name} when durable Project evidence satisfies this status boundary.`,
      doNotEnterWhen: `Do not enter ${name} for intent, questions, or agent control-plane activity.`
    })),
    transitions: [
      ['Backlog', 'Doing'],
      ['Doing', 'In review'],
      ['Doing', 'Blocked'],
      ['Blocked', 'Doing'],
      ['In review', 'Doing'],
      ['In review', 'Completed']
    ].map(([from, to]) => ({
      from,
      to,
      when: `Move from ${from} to ${to} only when durable evidence supports the target boundary.`,
      doNotApplyWhen: 'Do not move for planned work, questions, or unverified completion claims.'
    }))
  };
  await fs.writeFile(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
  const stored = await executeBackend({
    command: 'check',
    options: { session: 'session-check', 'rules-file': rulesPath }
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    githubClient: async () => client
  });
  assert.equal(stored.statusRuleGeneration.required, false);
  assert.ok(stored.statusRules.some(line => line.startsWith('Transition In review -> Completed:')));
  assert.deepEqual(stored.configurationChanges, []);
  metadata = await readProjectMetadata(dataDir, saved);
  assert.equal(metadata.statusRules.statuses.length, statuses.length);
  assert.equal(metadata.statusRules.transitions.length, rules.transitions.length);

  statuses = [...statuses].reverse();
  const reordered = await executeBackend({
    command: 'check', options: { session: 'session-check' }
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    githubClient: async () => client
  });
  assert.equal(reordered.statusRuleGeneration.required, false);

  statuses = ['Backlog', 'Doing', 'In review', 'Blocked', 'Completed', 'Cancelled'];
  const changed = await executeBackend({
    command: 'check', options: { session: 'session-check' }
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    githubClient: async () => client
  });
  assert.equal(changed.statusRuleGeneration.required, true);
  assert.equal(changed.statusRuleGeneration.reason, 'statuses_changed');
  assert.ok(changed.configurationChanges.some(change => change.path === 'kanban.terminalStatuses'));
  metadata = await readProjectMetadata(dataDir, saved);
  assert.equal(metadata.statusRules, null);
  assert.deepEqual(metadata.availableStatuses, statuses);

  const beforeMissingField = await fs.readFile(configPath, 'utf8');
  statuses = [];
  await assert.rejects(() => executeBackend({
    command: 'check', options: { session: 'session-check' }
  }, {
    dataDir,
    resourceRoot: root,
    environment: {},
    githubClient: async () => client
  }), { code: 'PROJECT_STATUS_FIELD_REQUIRED' });
  assert.equal(await fs.readFile(configPath, 'utf8'), beforeMissingField);
});
