import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProjectUrl } from '../scripts/mineprogress.mjs';
import { run } from '../scripts/mineprogress.mjs';
import { readProjectMetadata } from '../scripts/lib/metadata.mjs';

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

test('confirmed initialization writes config and global metadata to plugin data', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-init-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const previousToken = process.env.GITHUB_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  globalThis.fetch = async (_url, request) => {
    const { query } = JSON.parse(request.body);
    let data;
    if (query.includes('query($login')) {
      data = { user: { projectV2: {
        id: 'PVT_1', title: 'Tasks', public: false,
        fields: { nodes: [{ id: 'status', name: 'Status', options: [{ id: 'doing', name: 'Doing' }] }] },
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
  });
  const result = await run([
    'init', 'apply',
    '--project-url', 'https://github.com/users/octocat/projects/1',
    '--repository', 'octocat/todos',
    '--confirm',
    '--data-dir', dataDir
  ]);
  assert.equal(result.outcome, 'initialized');
  assert.equal(result.updateFieldCreated, true);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(saved.owner, 'octocat');
  const metadata = await readProjectMetadata(dataDir, saved);
  assert.deepEqual(metadata.availableStatuses, ['Doing']);
  assert.equal(metadata.creationPolicy.route, 'draft');
});
