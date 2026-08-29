import test from 'node:test';
import assert from 'node:assert/strict';
import { applyUpdatePlan, createDraftItem, createKanbanItem, createTextField, makeClient, normalizeProjectItem, readProject, selectCreationRoute } from '../scripts/lib/github-projects.mjs';

const config = {
  owner: 'octocat',
  ownerType: 'user',
  projectNumber: 1,
  statusFieldName: 'Status',
  updateFieldName: 'Update',
  defaultRepository: 'octocat/todos',
  creation: {
    projectVisibility: 'auto',
    repositoryVisibility: 'auto',
    routes: {
      public_private: 'issue',
      public_public: 'issue',
      private_private: 'issue',
      private_public: 'draft'
    }
  }
};

function projectPage({ hasNextPage = false, endCursor = null } = {}) {
  return {
    user: {
      projectV2: {
        id: 'PVT_1',
        public: false,
        fields: { nodes: [
          { id: 'status-field', name: 'Status', options: [{ id: 'done-option', name: 'Done' }] },
          { id: 'update-field', name: 'Update' }
        ] },
        items: { pageInfo: { hasNextPage, endCursor }, nodes: [] }
      }
    },
    organization: null
  };
}

test('client classifies invalid GitHub authentication without exposing token', async () => {
  const client = makeClient('secret-value', async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) }));
  await assert.rejects(client('query {}'), error => error.code === 'GH_AUTH_INVALID' && !error.message.includes('secret-value'));
});

test('project items normalize configured fields', () => {
  const item = normalizeProjectItem({
    id: 'PVTI_1',
    isArchived: false,
    content: { title: 'Ship' },
    fieldValues: { nodes: [
      { name: 'In progress', field: { name: 'Status' } },
      { text: 'Tests added', field: { name: 'Update' } }
    ] }
  }, config);
  assert.deepEqual(item, { itemId: 'PVTI_1', title: 'Ship', repository: null, archived: false, status: 'In progress', summary: 'Tests added' });
});

test('readProject follows item pagination', async () => {
  let calls = 0;
  const client = async () => {
    calls++;
    const page = projectPage({ hasNextPage: calls === 1, endCursor: calls === 1 ? 'cursor' : null });
    page.user.projectV2.items.nodes = [{ id: `item-${calls}`, content: { title: `Item ${calls}` }, fieldValues: { nodes: [] } }];
    return page;
  };
  const project = await readProject(config, client);
  assert.equal(calls, 2);
  assert.deepEqual(project.normalizedItems.map(item => item.itemId), ['item-1', 'item-2']);
});

test('create returns the new draft item id', async () => {
  const client = async query => query.includes('addProjectV2DraftIssue')
    ? { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_NEW' } } }
    : projectPage();
  assert.deepEqual(await createDraftItem(config, client, 'New todo'), { itemId: 'PVTI_NEW', title: 'New todo' });
});

test('approved plan applies status and summary with recoverable operation keys', async () => {
  const applied = [];
  const client = async query => query.includes('updateProjectV2ItemFieldValue') ? { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } : projectPage();
  const result = await applyUpdatePlan(config, client, { updates: [{ itemId: 'PVTI_1', status: 'Done', summary: 'Finished.' }] }, { onApplied: async key => applied.push(key) });
  assert.equal(result.applied, 2);
  assert.equal(applied.length, 2);
});

test('approved no-op does not contact GitHub', async () => {
  let called = false;
  const result = await applyUpdatePlan(config, async () => { called = true; }, { updates: [] });
  assert.equal(called, false);
  assert.deepEqual(result, { applied: 0, operations: [] });
});

test('creation route follows all four visibility combinations', () => {
  assert.equal(selectCreationRoute(config, 'public', 'private').route, 'issue');
  assert.equal(selectCreationRoute(config, 'public', 'public').route, 'issue');
  assert.equal(selectCreationRoute(config, 'private', 'private').route, 'issue');
  assert.equal(selectCreationRoute(config, 'private', 'public').route, 'draft');
});

test('public repository issue creation adds the issue to the Project', async () => {
  const calls = [];
  const publicConfig = { ...config, creation: { ...config.creation, projectVisibility: 'public', repositoryVisibility: 'public' } };
  const client = async (query, variables) => {
    calls.push(query);
    if (query.includes('query($login')) return projectPage();
    if (query.includes('repository(owner')) return { repository: { id: 'R_1', nameWithOwner: 'octocat/todos', visibility: 'PUBLIC' } };
    if (query.includes('createIssue')) return { createIssue: { issue: { id: 'I_1', number: 7, url: 'https://example.test/7' } } };
    if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: 'PVTI_7' } } };
    throw new Error(`Unexpected query with ${JSON.stringify(variables)}`);
  };
  const item = await createKanbanItem(publicConfig, client, 'Public task');
  assert.equal(item.kind, 'issue');
  assert.equal(item.itemId, 'PVTI_7');
  assert.equal(calls.some(query => query.includes('addProjectV2ItemById')), true);
});

test('guided initialization can create the configured update text field', async () => {
  let variables;
  const field = await createTextField(async (query, input) => {
    assert.match(query, /dataType:TEXT/);
    variables = input;
    return { createProjectV2Field: { projectV2Field: { id: 'PVTF_1', name: 'Update' } } };
  }, 'PVT_1', 'Update');
  assert.deepEqual(variables, { projectId: 'PVT_1', name: 'Update' });
  assert.equal(field.id, 'PVTF_1');
});
