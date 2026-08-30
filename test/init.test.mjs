import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProjectUrl, resolveInitializationRepository } from '../scripts/mineprogress.mjs';
import { run } from '../scripts/mineprogress.mjs';
import { readProjectMetadata } from '../scripts/lib/metadata.mjs';
import { detectTerminalStatuses, selectDefaultStatus } from '../scripts/lib/config.mjs';

test('Kanban defaults prefer a starting status and detect conventional terminal statuses', () => {
  const statuses = ['In progress', 'Todo', 'In review', 'Done'];
  assert.equal(selectDefaultStatus(statuses), 'Todo');
  assert.deepEqual(detectTerminalStatuses(statuses), ['Done']);
  assert.equal(selectDefaultStatus(['Doing', 'Shipped']), 'Doing');
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

test('guided initialization uses the sole repository linked to the Project', () => {
  const result = resolveInitializationRepository({}, { repositories: { nodes: [
    { nameWithOwner: 'octocat/todos', visibility: 'PUBLIC' }
  ] } });
  assert.deepEqual(result, {
    defaultRepository: 'octocat/todos',
    source: 'project',
    candidates: [{ nameWithOwner: 'octocat/todos', visibility: 'public' }],
    selectionRequired: false
  });
});

test('guided initialization requires a choice only for multiple linked repositories', () => {
  const project = { repositories: { nodes: [
    { nameWithOwner: 'octocat/one', visibility: 'PRIVATE' },
    { nameWithOwner: 'octocat/two', visibility: 'PUBLIC' }
  ] } };
  const ambiguous = resolveInitializationRepository({}, project);
  assert.equal(ambiguous.selectionRequired, true);
  assert.deepEqual(ambiguous.candidates.map(candidate => candidate.nameWithOwner), ['octocat/one', 'octocat/two']);
  assert.deepEqual(resolveInitializationRepository({ 'no-repository': true }, project), {
    defaultRepository: '',
    source: 'explicit-none',
    candidates: ambiguous.candidates,
    selectionRequired: false
  });
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
  assert.equal(saved.kanban.defaultStatus, 'Todo');
  assert.deepEqual(saved.kanban.terminalStatuses, ['Done']);
  assert.equal(result.defaultStatus, 'Todo');
  assert.equal(result.defaultStatusSource, 'detected');
  const metadata = await readProjectMetadata(dataDir, saved);
  assert.deepEqual(metadata.availableStatuses, ['Doing', 'Todo', 'Done']);
  assert.equal(metadata.creationPolicy.route, 'draft');
});

test('initialization rejects legacy preview and apply phases', async () => {
  await assert.rejects(() => run([
    'init', 'preview',
    '--project-url', 'https://github.com/users/octocat/projects/1',
    '--data-dir', 'unused'
  ]), { code: 'INIT_ACTION_INVALID' });
});
