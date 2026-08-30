import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPreparedOperations, applyUpdatePlan, createDraftItem, createKanbanItem, createTextField, deleteKanbanItem, makeClient, normalizeProjectItem, prepareUpdateOperations, readManagedDraftEvidence, readManagedEvidence, readProject, reconcilePreparedOperations, selectCreationRoute } from '../scripts/lib/github-projects.mjs';

const config = {
  owner: 'octocat',
  ownerType: 'user',
  projectNumber: 1,
  statusFieldName: 'Status',
  updateFieldName: 'Update',
  kanban: { defaultStatus: 'Todo', terminalStatuses: ['Done'] },
  creation: {
    repository: 'octocat/todos',
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
        repositories: { totalCount: 1, nodes: [{ nameWithOwner: 'octocat/todos', visibility: 'PUBLIC' }] },
        fields: { nodes: [
          { id: 'status-field', name: 'Status', options: [
            { id: 'todo-option', name: 'Todo' },
            { id: 'done-option', name: 'Done' }
          ] },
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
    content: { __typename: 'Issue', id: 'I_1', title: 'Ship', body: 'Existing body', state: 'OPEN', url: 'https://example.test/1' },
    fieldValues: { nodes: [
      { name: 'In progress', field: { name: 'Status' } },
      { text: 'Tests added', field: { name: 'Update' } }
    ] }
  }, config);
  assert.deepEqual(item, {
    itemId: 'PVTI_1', title: 'Ship', contentId: 'I_1', contentType: 'issue', contentState: 'OPEN', body: 'Existing body',
    url: 'https://example.test/1', repository: null, archived: false, status: 'In progress', summary: 'Tests added'
  });
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

test('readProject queries only the configured owner type', async () => {
  await readProject(config, async query => {
    assert.match(query, /\buser\(login:/);
    assert.doesNotMatch(query, /\borganization\(login:/);
    assert.match(query, /repositories\(first:100\)/);
    return projectPage();
  });

  const organizationConfig = { ...config, owner: 'acme', ownerType: 'organization' };
  await readProject(organizationConfig, async query => {
    assert.match(query, /\borganization\(login:/);
    assert.doesNotMatch(query, /\buser\(login:/);
    return { organization: { projectV2: projectPage().user.projectV2 } };
  });
});

test('create returns the new draft item id', async () => {
  const client = async query => query.includes('addProjectV2DraftIssue')
    ? { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_NEW' } } }
    : projectPage();
  assert.deepEqual(await createDraftItem(config, client, 'New todo'), { itemId: 'PVTI_NEW', title: 'New todo' });
});

test('approved plan applies status and summary with recoverable operation keys', async () => {
  const applied = [];
  const client = async query => query.includes('operation0:updateProjectV2ItemFieldValue')
    ? { operation0: { projectV2Item: { id: 'PVTI_1' } } }
    : projectPage();
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

test('prepared field updates are submitted in one GraphQL mutation', async () => {
  let calls = 0;
  const result = await applyPreparedOperations(async (query, variables) => {
    calls++;
    assert.match(query, /operation0:updateProjectV2ItemFieldValue/);
    assert.match(query, /operation1:updateProjectV2ItemFieldValue/);
    assert.equal(variables.projectId, 'PVT_1');
    return {
      operation0: { projectV2Item: { id: 'PVTI_1' } },
      operation1: { projectV2Item: { id: 'PVTI_1' } }
    };
  }, 'PVT_1', [
    { kind: 'status', itemId: 'PVTI_1', fieldId: 'STATUS', value: { singleSelectOptionId: 'DONE' } },
    { kind: 'summary', itemId: 'PVTI_1', fieldId: 'UPDATE', value: { text: 'Finished.' } }
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(result, { applied: 2 });
});

test('initial Issue proposal and progress comment are explicitly authorized and externally reconcilable', async () => {
  const body = '<!-- mineprogress:managed:start -->\n## Abstract\nParser proposal.\n<!-- mineprogress:managed:end -->';
  const project = {
    id: 'PVT_1',
    fields: { nodes: [] },
    normalizedItems: [{
      itemId: 'PVTI_1', contentId: 'I_1', contentType: 'issue', body: '', status: null, summary: null
    }]
  };
  const prepared = prepareUpdateOperations(config, project, {
    updates: [{ itemId: 'PVTI_1', body, comment: 'Parser phase completed.' }]
  }, { proposalBodyItemIds: ['PVTI_1'] });
  assert.deepEqual(prepared.operations.map(operation => operation.kind), ['proposalBody', 'comment']);
  assert.match(prepared.operations[1].value.body, /mineprogress:comment:/);

  let submittedVariables;
  await applyPreparedOperations(async (query, variables) => {
    if (query.startsWith('query')) return { node: { body: '' } };
    submittedVariables = variables;
    assert.match(query, /operation0:updateIssue/);
    assert.match(query, /operation1:addComment/);
    assert.doesNotMatch(query, /\$projectId/);
    return {
      operation0: { issue: { id: 'I_1' } },
      operation1: { commentEdge: { node: { id: 'IC_1' } } }
    };
  }, project.id, prepared.operations);
  assert.equal(submittedVariables.contentId0, 'I_1');

  project.normalizedItems[0].body = body;
  const report = await reconcilePreparedOperations(project, prepared.operations, {
    client: async (_query, variables) => ({
      node: {
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ body: `Recorded.\n${prepared.operations[1].expected}` }]
        }
      }
    })
  });
  assert.deepEqual(report.confirmed.map(operation => operation.kind), ['proposalBody', 'comment']);
  assert.equal(report.retryable.length, 0);
});

test('operation preparation locks Issue bodies and permits only exact Draft appends', async () => {
  const issue = {
    id: 'PVT_1', fields: { nodes: [] }, normalizedItems: [{
      itemId: 'ISSUE_ITEM', contentId: 'I_1', contentType: 'issue', body: 'Proposal.'
    }]
  };
  assert.throws(() => prepareUpdateOperations(config, issue, {
    updates: [{ itemId: 'ISSUE_ITEM', body: 'Replacement.' }]
  }), error => error.code === 'ISSUE_BODY_IMMUTABLE');

  const draft = {
    id: 'PVT_1', fields: { nodes: [] }, normalizedItems: [{
      itemId: 'DRAFT_ITEM', contentId: 'DI_1', contentType: 'draft', body: 'Proposal.'
    }]
  };
  assert.throws(() => prepareUpdateOperations(config, draft, {
    updates: [{ itemId: 'DRAFT_ITEM', body: 'Changed.\nProgress.' }]
  }), error => error.code === 'DRAFT_BODY_APPEND_ONLY');
  const prepared = prepareUpdateOperations(config, draft, {
    updates: [{ itemId: 'DRAFT_ITEM', body: 'Proposal.\n\nProgress.' }]
  });
  assert.equal(prepared.operations[0].kind, 'draftAppend');
  await assert.rejects(applyPreparedOperations(async query => {
    if (query.startsWith('query')) return { node: { body: 'Externally changed.' } };
    throw new Error('Mutation must not run');
  }, draft.id, prepared.operations), error => error.code === 'CONTENT_BODY_CONFLICT');
});

test('primary repository uses a guarded Issue-body update instead of a comment append', async () => {
  const body = `<!-- mineprogress:managed:start -->
## Abstract

Repository-aware proposal.

## Background and Significance

Background.
<!-- mineprogress:managed:end -->`;
  const project = {
    id: 'PVT_1', fields: { nodes: [] }, normalizedItems: [{
      itemId: 'ISSUE_ITEM', contentId: 'I_1', contentType: 'issue', body
    }]
  };
  const prepared = prepareUpdateOperations(config, project, {
    updates: [{ itemId: 'ISSUE_ITEM', comment: 'Repository metadata synchronized.' }]
  }, {
    repositoryReferences: [{
      itemId: 'ISSUE_ITEM',
      url: 'https://github.com/octocat/example',
      description: 'Primary source repository for the example.'
    }]
  });
  assert.deepEqual(prepared.operations.map(operation => operation.kind), ['repositoryReference', 'comment']);
  assert.match(prepared.operations[0].expected, /## Repository/u);
  assert.doesNotMatch(prepared.operations[1].value.body, /github\.com/u);

  await applyPreparedOperations(async (query, variables) => {
    if (query.startsWith('query')) return { node: { body } };
    assert.match(query, /operation0:updateIssue/u);
    assert.match(query, /operation1:addComment/u);
    assert.match(variables.body0, /## Repository/u);
    return {
      operation0: { issue: { id: 'I_1' } },
      operation1: { commentEdge: { node: { id: 'IC_1' } } }
    };
  }, project.id, prepared.operations);
});

test('resume reconciliation distinguishes confirmed, retryable, and conflicting operations', async () => {
  const project = { normalizedItems: [
    { itemId: 'confirmed', status: 'Done', summary: null },
    { itemId: 'retry', status: 'Todo', summary: null },
    { itemId: 'conflict', status: 'Blocked', summary: null }
  ] };
  const operation = (itemId, before, expected) => ({ key: itemId, kind: 'status', itemId, before, expected });
  const report = await reconcilePreparedOperations(project, [
    operation('confirmed', 'Todo', 'Done'),
    operation('retry', 'Todo', 'Done'),
    operation('conflict', 'Todo', 'Done')
  ]);
  assert.deepEqual(report.confirmed.map(candidate => candidate.key), ['confirmed']);
  assert.deepEqual(report.retryable.map(candidate => candidate.key), ['retry']);
  assert.deepEqual(report.conflicts.map(({ operation: candidate }) => candidate.key), ['conflict']);
});

test('creation route follows all four visibility combinations', () => {
  assert.equal(selectCreationRoute(config, 'public', 'private').route, 'issue');
  assert.equal(selectCreationRoute(config, 'public', 'public').route, 'issue');
  assert.equal(selectCreationRoute(config, 'private', 'private').route, 'issue');
  assert.equal(selectCreationRoute(config, 'private', 'public').route, 'draft');
});

test('public repository issue creation adds the issue to the Project', async () => {
  const calls = [];
  const inputs = [];
  const publicConfig = { ...config, creation: { ...config.creation, projectVisibility: 'public', repositoryVisibility: 'public' } };
  const client = async (query, variables) => {
    calls.push(query);
    inputs.push(variables);
    if (query.includes('query($login')) return projectPage();
    if (query.includes('repository(owner')) return { repository: { id: 'R_1', nameWithOwner: 'octocat/todos', visibility: 'PUBLIC' } };
    if (query.includes('createIssue')) return { createIssue: { issue: { id: 'I_1', number: 7, url: 'https://example.test/7' } } };
    if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: 'PVTI_7' } } };
    if (query.includes('updateProjectV2ItemFieldValue')) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } };
    throw new Error(`Unexpected query with ${JSON.stringify(variables)}`);
  };
  const item = await createKanbanItem(publicConfig, client, 'Public task', 'Initial body');
  assert.equal(item.kind, 'issue');
  assert.equal(item.itemId, 'PVTI_7');
  assert.equal(calls.some(query => query.includes('addProjectV2ItemById')), true);
  assert.equal(item.defaultStatus, 'Todo');
  assert.equal(inputs.find(input => input?.value?.singleSelectOptionId)?.value.singleSelectOptionId, 'todo-option');
  assert.equal(inputs.find(input => input?.repositoryId)?.body, 'Initial body');
});

test('private Project with public repository creates a draft through projectItem payload', async () => {
  const calls = [];
  const client = async query => {
    calls.push(query);
    if (query.includes('query($login')) return projectPage();
    if (query.includes('repository(owner')) return { repository: { id: 'R_1', nameWithOwner: 'octocat/todos', visibility: 'PUBLIC' } };
    if (query.includes('addProjectV2DraftIssue')) return { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_DRAFT' } } };
    if (query.includes('updateProjectV2ItemFieldValue')) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_DRAFT' } } };
    throw new Error('Unexpected query');
  };
  const item = await createKanbanItem(config, client, 'Private task');
  assert.equal(item.kind, 'draft');
  assert.equal(item.itemId, 'PVTI_DRAFT');
  assert.equal(item.defaultStatus, 'Todo');
  assert.match(calls.find(query => query.includes('addProjectV2DraftIssue')), /projectItem \{ id \}/);
  assert.equal(calls.filter(query => query.includes('updateProjectV2ItemFieldValue')).length, 1);
});

test('terminal and active status updates synchronize linked Issue state', async () => {
  const project = {
    id: 'PVT_1',
    fields: projectPage().user.projectV2.fields,
    normalizedItems: [{
      itemId: 'PVTI_1', contentId: 'I_1', contentType: 'issue', contentState: 'OPEN',
      status: 'Todo', summary: null, body: ''
    }]
  };
  const closing = prepareUpdateOperations(config, project, { updates: [{ itemId: 'PVTI_1', status: 'Done' }] });
  assert.deepEqual(closing.operations.map(operation => operation.kind), ['status', 'issueState']);
  assert.equal(closing.operations[1].expected, 'CLOSED');
  await applyPreparedOperations(async (query, variables) => {
    assert.match(query, /operation0:updateProjectV2ItemFieldValue/);
    assert.match(query, /operation1:updateIssue/);
    assert.equal(variables.state1, 'CLOSED');
    return {
      operation0: { projectV2Item: { id: 'PVTI_1' } },
      operation1: { issue: { id: 'I_1', state: 'CLOSED' } }
    };
  }, project.id, closing.operations);
  project.normalizedItems[0].contentState = 'CLOSED';
  project.normalizedItems[0].status = 'Done';
  const reopening = prepareUpdateOperations(config, project, { updates: [{ itemId: 'PVTI_1', status: 'Todo' }] });
  assert.deepEqual(reopening.operations.map(operation => operation.kind), ['status', 'issueState']);
  assert.equal(reopening.operations[1].expected, 'OPEN');
});

test('explicit Project item deletion closes its Issue first', async () => {
  const project = {
    id: 'PVT_1',
    normalizedItems: [{ itemId: 'PVTI_1', contentId: 'I_1', contentType: 'issue', contentState: 'OPEN' }]
  };
  const calls = [];
  const result = await deleteKanbanItem(async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('updateIssue')) return { updateIssue: { issue: { id: 'I_1', state: 'CLOSED' } } };
    if (query.includes('deleteProjectV2Item')) return { deleteProjectV2Item: { deletedItemId: 'PVTI_1' } };
    throw new Error('Unexpected mutation');
  }, project, 'PVTI_1');
  assert.deepEqual(result, { itemId: 'PVTI_1', projectItemDeleted: true, issueClosed: true });
  assert.match(calls[0].query, /updateIssue/);
  assert.match(calls[1].query, /deleteProjectV2Item/);
});

test('explicit deletion still closes a cached Issue when its Project item is already gone', async () => {
  const calls = [];
  const result = await deleteKanbanItem(async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('updateIssue')) return { updateIssue: { issue: { id: 'I_2', state: 'CLOSED' } } };
    throw new Error('Unexpected mutation');
  }, { id: 'PVT_1', normalizedItems: [] }, 'PVTI_2', {
    contentId: 'I_2',
    contentType: 'issue'
  });
  assert.deepEqual(result, { itemId: 'PVTI_2', projectItemDeleted: false, issueClosed: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /updateIssue/);
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

test('managed GitHub progress is recovered as compact structured evidence', async () => {
  let page = 0;
  const facts = await readManagedEvidence(async (_query, variables) => {
    page++;
    assert.equal(variables.id, 'I_1');
    return { node: { comments: {
      pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? 'next' : null },
      nodes: page === 1 ? [{
        body: 'Unmanaged conversation.', url: 'https://example.test/unmanaged', createdAt: '2026-08-29T00:00:00Z'
      }] : [{
        body: '## Progress Update — 2026-08-30\n\n### Requirements\n\nKeep durable evidence.\n\n### Results\n\nRecovery passed.\n\n<!-- mineprogress:comment:key -->',
        url: 'https://example.test/comment/1', createdAt: '2026-08-30T00:00:00Z'
      }]
    } } };
  }, 'I_1');
  assert.equal(page, 2);
  assert.equal(facts.length, 1);
  assert.match(facts[0].text, /Requirements:\nKeep durable evidence\./u);
  assert.match(facts[0].text, /Results:\nRecovery passed\./u);
  assert.doesNotMatch(facts[0].text, /mineprogress:comment/u);
});

test('managed Draft progress sections are recovered without rewriting the body', () => {
  const facts = readManagedDraftEvidence([
    '# Proposal', '', '## Progress Update — 2026-08-29', '', '### Requirements', '',
    'First requirement.', '', '### Results', '', 'First result.', '',
    '## Progress Update — 2026-08-30', '', '### Requirements', '',
    'Second requirement.', '', '### Results', '', 'Second result.'
  ].join('\n'), 'https://example.test/draft');
  assert.equal(facts.length, 2);
  assert.match(facts[1].text, /Second result/u);
});
