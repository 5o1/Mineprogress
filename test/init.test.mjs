import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProjectUrl, resolveInitializationCreationRepository } from '../scripts/mineprogress.mjs';
import { run } from '../scripts/mineprogress.mjs';
import { readProjectMetadata } from '../scripts/lib/metadata.mjs';
import {
  createConfig,
  detectStatusRoles,
  detectTerminalStatuses,
  selectDefaultStatus,
  synchronizeKanbanConfig
} from '../scripts/lib/config.mjs';

test('Kanban defaults prefer a starting status and detect conventional terminal statuses', () => {
  const statuses = ['In progress', 'Todo', 'In review', 'Done'];
  assert.equal(selectDefaultStatus(statuses), 'Todo');
  assert.deepEqual(detectTerminalStatuses(statuses), ['Done']);
  assert.deepEqual(detectStatusRoles(statuses), {
    queued: 'Todo', active: 'In progress', review: 'In review', blocked: '', completed: 'Done'
  });
  assert.equal(selectDefaultStatus(['Doing', 'Shipped']), 'Doing');
});

test('Kanban synchronization preserves valid mappings and replaces missing remote statuses', () => {
  const current = createConfig({
    kanban: {
      defaultStatus: 'Todo',
      terminalStatuses: ['Done', 'Cancelled'],
      statusRoles: {
        queued: 'Todo', active: 'Doing', review: 'Review', blocked: '', completed: 'Done'
      }
    }
  });
  const result = synchronizeKanbanConfig(current, ['Backlog', 'Doing', 'In review', 'Blocked', 'Completed']);
  assert.equal(result.config.kanban.defaultStatus, 'Backlog');
  assert.deepEqual(result.config.kanban.terminalStatuses, ['Completed']);
  assert.deepEqual(result.config.kanban.statusRoles, {
    queued: 'Backlog', active: 'Doing', review: 'In review', blocked: 'Blocked', completed: 'Completed'
  });
  assert.ok(result.changes.some(change => change.path === 'kanban.defaultStatus'));
  assert.ok(result.changes.some(change => change.path === 'kanban.statusRoles.review'));
});

test('guided initialization parses user and organization Project URLs', () => {
  assert.deepEqual(parseProjectUrl('https://github.com/users/octocat/projects/12/views/1'), {
    owner: 'octocat', ownerType: 'user', projectNumber: 12
  });
  assert.deepEqual(parseProjectUrl('https://github.com/orgs/acme/projects/3'), {
    owner: 'acme', ownerType: 'organization', projectNumber: 3
  });
});

test('guided initialization rejects non-GitHub and malformed Project URLs', () => {
  assert.throws(() => parseProjectUrl('https://example.com/users/a/projects/1'), { code: 'PROJECT_URL_INVALID' });
  assert.throws(() => parseProjectUrl('https://github.com/a/projects/1'), { code: 'PROJECT_URL_INVALID' });
});

test('guided initialization may use the sole linked repository without calling it the Project default', () => {
  const result = resolveInitializationCreationRepository({}, { repositories: { nodes: [
    { nameWithOwner: 'octocat/todos', visibility: 'PUBLIC' }
  ] } });
  assert.deepEqual(result, {
    repository: 'octocat/todos',
    source: 'sole-linked',
    candidates: [{ nameWithOwner: 'octocat/todos', visibility: 'public' }],
    selectionRequired: false
  });
});

test('guided initialization requires a choice only for multiple linked repositories', () => {
  const project = { repositories: { nodes: [
    { nameWithOwner: 'octocat/one', visibility: 'PRIVATE' },
    { nameWithOwner: 'octocat/two', visibility: 'PUBLIC' }
  ] } };
  const ambiguous = resolveInitializationCreationRepository({}, project);
  assert.equal(ambiguous.selectionRequired, true);
  assert.deepEqual(ambiguous.candidates.map(candidate => candidate.nameWithOwner), ['octocat/one', 'octocat/two']);
  assert.deepEqual(resolveInitializationCreationRepository({ 'no-repository': true }, project), {
    repository: '',
    source: 'explicit-none',
    candidates: ambiguous.candidates,
    selectionRequired: false
  });
});

test('legacy defaultRepository config migrates to creation.repository', () => {
  const migrated = createConfig({ defaultRepository: 'octocat/todos' });
  assert.equal(migrated.creation.repository, 'octocat/todos');
  assert.equal('defaultRepository' in migrated, false);
  const current = createConfig({
    defaultRepository: 'octocat/legacy',
    creation: { repository: 'octocat/current' }
  });
  assert.equal(current.creation.repository, 'octocat/current');
});

test('initialization writes config and global metadata without a preview phase', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-init-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const previousToken = process.env.GITHUB_TOKEN;
  const previousDisableGh = process.env.MINEPROGRESS_DISABLE_GH_AUTH;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.MINEPROGRESS_DISABLE_GH_AUTH = '1';
  globalThis.fetch = async (_url, request) => {
    const { query } = JSON.parse(request.body);
    let data;
    if (query.includes('query($login')) {
      data = { user: { projectV2: {
        id: 'PVT_1', title: 'Tasks', public: false,
        repositories: { totalCount: 1, nodes: [{ nameWithOwner: 'octocat/todos', visibility: 'PUBLIC' }] },
        fields: { nodes: [{ id: 'status', name: 'Status', options: [
          { id: 'doing', name: 'Doing' },
          { id: 'todo', name: 'Todo' },
          { id: 'done', name: 'Done' }
        ] }] },
        items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
      } }, organization: null };
    } else if (query.includes('repository(owner')) {
      data = { repository: { id: 'R_1', nameWithOwner: 'octocat/todos', visibility: 'PUBLIC' } };
    } else if (query.includes('createProjectV2Field')) {
      data = { createProjectV2Field: { projectV2Field: { id: 'update', name: 'Update' } } };
    } else {
      throw new Error('Unexpected GraphQL operation');
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
    if (previousDisableGh === undefined) delete process.env.MINEPROGRESS_DISABLE_GH_AUTH; else process.env.MINEPROGRESS_DISABLE_GH_AUTH = previousDisableGh;
  });
  const result = await run([
    'init',
    '--project-url', 'https://github.com/users/octocat/projects/1',
    '--repository', 'octocat/todos',
    '--data-dir', dataDir
  ]);
  assert.equal(result.outcome, 'initialized');
  assert.equal(result.updateFieldCreated, true);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(saved.owner, 'octocat');
  assert.equal(saved.creation.repository, 'octocat/todos');
  assert.equal('defaultRepository' in saved, false);
  assert.equal(saved.kanban.defaultStatus, 'Todo');
  assert.deepEqual(saved.kanban.terminalStatuses, ['Done']);
  assert.deepEqual(saved.kanban.statusRoles, {
    queued: 'Todo', active: 'Doing', review: '', blocked: '', completed: 'Done'
  });
  assert.equal(result.defaultStatus, 'Todo');
  assert.equal(result.defaultStatusSource, 'detected');
  assert.equal(result.creationRepository, 'octocat/todos');
  assert.equal(result.creationRepositorySource, 'explicit');
  assert.equal(result.statusRuleGeneration.required, true);
  assert.equal(result.statusRuleGeneration.reason, 'initialization');
  assert.deepEqual(result.statusRuleGeneration.statusRoles, result.statusRoles);
  const metadata = await readProjectMetadata(dataDir, saved);
  assert.deepEqual(metadata.availableStatuses, ['Doing', 'Todo', 'Done']);
  assert.equal(metadata.statusRules, null);
  assert.equal(metadata.creationPolicy.route, 'draft');
});

test('initialization rejects legacy preview and apply phases', async () => {
  await assert.rejects(() => run([
    'init', 'preview',
    '--project-url', 'https://github.com/users/octocat/projects/1',
    '--data-dir', 'unused'
  ]), { code: 'INIT_ACTION_INVALID' });
});
