import crypto from 'node:crypto';
import { creationRepository } from './config.mjs';
import { canManageRepositoryReference, normalizePrimaryRepository, upsertRepositoryReference } from './repository-reference.mjs';

function infrastructureError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function makeClient(token, fetchImpl = globalThis.fetch) {
  if (!token) throw infrastructureError('Set GITHUB_TOKEN or GH_TOKEN.', 'GH_TOKEN_MISSING');
  return async function graphql(query, variables = {}) {
    let response;
    try {
      response = await fetchImpl('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          authorization: `bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'mineprogress'
        },
        body: JSON.stringify({ query, variables })
      });
    } catch (error) {
      if (error?.code === 'SANDBOX_DENIED') throw error;
      throw infrastructureError('GitHub API network request failed.', 'GH_NETWORK_ERROR', error);
    }
    let body;
    try { body = await response.json(); } catch (error) {
      throw infrastructureError(`GitHub API returned an unreadable response (${response.status}).`, 'GH_RESPONSE_INVALID', error);
    }
    if (!response.ok || body.errors?.length) {
      const message = body.errors?.map(entry => entry.message).join('; ') || `GitHub API ${response.status}`;
      const code = response.status === 401 ? 'GH_AUTH_INVALID'
        : response.status === 403 ? 'GH_PERMISSION_OR_RATE_LIMIT'
          : response.status >= 500 ? 'GH_SERVER_ERROR' : 'GH_GRAPHQL_ERROR';
      throw infrastructureError(message, code);
    }
    return body.data;
  };
}

const PROJECT_FRAGMENT = `fragment ProjectData on ProjectV2 {
  id title url public
  repositories(first:100) {
    totalCount
    nodes { nameWithOwner visibility }
  }
  fields(first:50) { nodes {
    ... on ProjectV2FieldCommon { id name }
    ... on ProjectV2SingleSelectField { id name options { id name } }
  } }
  items(first:100, after:$after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id isArchived
      content {
        __typename
        ... on DraftIssue { id title body }
        ... on Issue { id title number url body state repository { nameWithOwner } }
        ... on PullRequest { id title number url body repository { nameWithOwner } }
      }
      fieldValues(first:20) { nodes {
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
        ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { id name } } }
      } }
    }
  }
}`;

function projectQuery(ownerType) {
  const rootField = ownerType === 'organization' ? 'organization' : 'user';
  return `query($login:String!, $number:Int!, $after:String) {
    ${rootField}(login:$login) { projectV2(number:$number) { ...ProjectData } }
  }
  ${PROJECT_FRAGMENT}`;
}

function selectProject(data, ownerType) {
  return ownerType === 'organization' ? data.organization?.projectV2 : data.user?.projectV2;
}

export function normalizeProjectItem(item, config) {
  const fields = new Map((item.fieldValues?.nodes || [])
    .filter(value => value.field?.name)
    .map(value => [value.field.name, value]));
  const contentType = item.content?.__typename === 'Issue' ? 'issue'
    : item.content?.__typename === 'DraftIssue' ? 'draft'
      : item.content?.__typename === 'PullRequest' ? 'pullRequest' : null;
  return {
    itemId: item.id,
    title: item.content?.title || '(untitled draft)',
    contentId: item.content?.id || null,
    contentType,
    contentState: contentType === 'issue' ? item.content?.state || null : null,
    body: item.content?.body || '',
    url: item.content?.url || null,
    repository: item.content?.repository?.nameWithOwner || null,
    archived: Boolean(item.isArchived),
    status: fields.get(config.statusFieldName)?.name || null,
    summary: fields.get(config.updateFieldName)?.text || null
  };
}

export function projectStatusOptions(project, config) {
  const field = (project.fields?.nodes || []).find(candidate => candidate.name === config.statusFieldName);
  if (!field) throw infrastructureError(`Project field not found: ${config.statusFieldName}`, 'PROJECT_FIELD_MISSING');
  return (field.options || []).map(option => ({ id: option.id, name: option.name }));
}

function statusOption(project, config, status) {
  const field = (project.fields?.nodes || []).find(candidate => candidate.name === config.statusFieldName);
  if (!field) throw infrastructureError(`Project field not found: ${config.statusFieldName}`, 'PROJECT_FIELD_MISSING');
  const option = field.options?.find(candidate => candidate.name === status);
  if (!option) throw infrastructureError(`Status option not found: ${status}`, 'PROJECT_STATUS_OPTION_MISSING');
  return { field, option };
}

export async function setProjectItemStatus(config, client, project, itemId, status) {
  const { field, option } = statusOption(project, config, status);
  const mutation = `mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $value:ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:$value}) {
      projectV2Item { id }
    }
  }`;
  const data = await client(mutation, {
    projectId: project.id,
    itemId,
    fieldId: field.id,
    value: { singleSelectOptionId: option.id }
  });
  if (!data.updateProjectV2ItemFieldValue?.projectV2Item?.id) {
    throw infrastructureError('GitHub did not confirm the default Project status.', 'GH_RESPONSE_INVALID');
  }
  return status;
}

export async function createTextField(client, projectId, name) {
  const mutation = `mutation($projectId:ID!, $name:String!) {
    createProjectV2Field(input:{projectId:$projectId,name:$name,dataType:TEXT}) {
      projectV2Field { ... on ProjectV2Field { id name } }
    }
  }`;
  const data = await client(mutation, { projectId, name });
  if (!data.createProjectV2Field?.projectV2Field?.id) {
    throw infrastructureError(`GitHub did not create Project field: ${name}`, 'PROJECT_FIELD_CREATE_FAILED');
  }
  return data.createProjectV2Field.projectV2Field;
}

export async function readProject(config, client) {
  let after = null;
  let combined = null;
  do {
    const data = await client(projectQuery(config.ownerType), { login: config.owner, number: config.projectNumber, after });
    const page = selectProject(data, config.ownerType);
    if (!page) throw infrastructureError('Configured GitHub Project was not found.', 'PROJECT_NOT_FOUND');
    if (!combined) combined = { ...page, items: { nodes: [] } };
    combined.items.nodes.push(...(page.items?.nodes || []));
    after = page.items?.pageInfo?.hasNextPage ? page.items.pageInfo.endCursor : null;
  } while (after);
  combined.normalizedItems = combined.items.nodes.map(item => normalizeProjectItem(item, config));
  return combined;
}

export async function createDraftItem(config, client, title, body = '') {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) throw Object.assign(new Error('A non-empty title is required.'), { code: 'CREATE_TITLE_REQUIRED' });
  if ([...normalizedTitle].length > 256) throw Object.assign(new Error('Title must not exceed 256 characters.'), { code: 'CREATE_TITLE_INVALID' });
  const project = await readProject(config, client);
  const mutation = `mutation($projectId:ID!, $title:String!, $body:String!) {
    addProjectV2DraftIssue(input:{projectId:$projectId,title:$title,body:$body}) { projectItem { id } }
  }`;
  const data = await client(mutation, { projectId: project.id, title: normalizedTitle, body: String(body || '') });
  return { itemId: data.addProjectV2DraftIssue?.projectItem?.id, title: normalizedTitle };
}

function splitRepository(nameWithOwner) {
  const parts = String(nameWithOwner || '').split('/');
  if (parts.length !== 2 || parts.some(part => !part)) {
    throw infrastructureError('creation.repository must use owner/name format.', 'CONFIG_INVALID');
  }
  return { owner: parts[0], name: parts[1] };
}

export async function readRepository(client, nameWithOwner) {
  const { owner, name } = splitRepository(nameWithOwner);
  const query = `query($owner:String!, $name:String!) { repository(owner:$owner,name:$name) { id nameWithOwner visibility } }`;
  const data = await client(query, { owner, name });
  if (!data.repository) throw infrastructureError('Configured Issue repository was not found.', 'REPOSITORY_NOT_FOUND');
  return data.repository;
}

export function selectCreationRoute(config, projectVisibility, repositoryVisibility) {
  if (!creationRepository(config)) return { route: 'draft', key: 'no_creation_repository' };
  const project = config.creation.projectVisibility === 'auto' ? projectVisibility : config.creation.projectVisibility;
  const repository = config.creation.repositoryVisibility === 'auto' ? repositoryVisibility : config.creation.repositoryVisibility;
  if (!['public', 'private'].includes(project) || !['public', 'private'].includes(repository)) {
    throw infrastructureError('Project or repository visibility is unknown.', 'VISIBILITY_UNKNOWN');
  }
  const key = `${project}_${repository}`;
  return { route: config.creation.routes[key], key, projectVisibility: project, repositoryVisibility: repository };
}

export async function inspectCreationPolicy(config, client, existingProject) {
  const project = existingProject || await readProject(config, client);
  const configuredRepository = creationRepository(config);
  if (!configuredRepository) {
    return { route: 'draft', key: 'no_creation_repository', projectVisibility: project.public ? 'public' : 'private', repositoryVisibility: null, repository: null };
  }
  const repository = await readRepository(client, configuredRepository);
  return {
    ...selectCreationRoute(config, project.public ? 'public' : 'private', repository.visibility.toLowerCase()),
    repository: repository.nameWithOwner,
    projectId: project.id,
    repositoryId: repository.id
  };
}

export async function createKanbanItem(config, client, title, body = '') {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) throw Object.assign(new Error('A non-empty title is required.'), { code: 'CREATE_TITLE_REQUIRED' });
  if ([...normalizedTitle].length > 256) throw Object.assign(new Error('Title must not exceed 256 characters.'), { code: 'CREATE_TITLE_INVALID' });
  const project = await readProject(config, client);
  const defaultStatus = config.kanban?.defaultStatus;
  if (!defaultStatus) {
    throw infrastructureError('kanban.defaultStatus is missing; rerun Mineprogress init.', 'PROJECT_DEFAULT_STATUS_REQUIRED');
  }
  statusOption(project, config, defaultStatus);
  const policy = await inspectCreationPolicy(config, client, project);
  if (policy.route === 'draft') {
    const mutation = `mutation($projectId:ID!, $title:String!, $body:String!) {
      addProjectV2DraftIssue(input:{projectId:$projectId,title:$title,body:$body}) { projectItem { id } }
    }`;
    const data = await client(mutation, { projectId: project.id, title: normalizedTitle, body: String(body || '') });
    const itemId = data.addProjectV2DraftIssue?.projectItem?.id;
    if (!itemId) throw infrastructureError('GitHub did not return the created draft item id.', 'GH_RESPONSE_INVALID');
    await setProjectItemStatus(config, client, project, itemId, defaultStatus);
    return { itemId, title: normalizedTitle, kind: 'draft', contentType: 'draft', defaultStatus, policy };
  }
  const createMutation = `mutation($repositoryId:ID!, $title:String!, $body:String!) {
    createIssue(input:{repositoryId:$repositoryId,title:$title,body:$body}) { issue { id number url } }
  }`;
  const created = await client(createMutation, { repositoryId: policy.repositoryId, title: normalizedTitle, body: String(body || '') });
  const issue = created.createIssue?.issue;
  if (!issue?.id) throw infrastructureError('GitHub did not return the created issue id.', 'GH_RESPONSE_INVALID');
  const addMutation = `mutation($projectId:ID!, $contentId:ID!) {
    addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}) { item { id } }
  }`;
  const added = await client(addMutation, { projectId: project.id, contentId: issue.id });
  const itemId = added.addProjectV2ItemById?.item?.id;
  if (!itemId) throw infrastructureError(`Issue ${issue.url || issue.number} was created but could not be added to the Project.`, 'PROJECT_ADD_ITEM_FAILED');
  await setProjectItemStatus(config, client, project, itemId, defaultStatus);
  return {
    itemId,
    title: normalizedTitle,
    kind: 'issue',
    contentId: issue.id,
    contentType: 'issue',
    contentState: 'OPEN',
    issueNumber: issue.number,
    issueUrl: issue.url,
    url: issue.url,
    repository: creationRepository(config),
    defaultStatus,
    policy
  };
}

async function setIssueState(client, contentId, state) {
  const mutation = `mutation($id:ID!, $state:IssueState!) {
    updateIssue(input:{id:$id,state:$state}) { issue { id state } }
  }`;
  const data = await client(mutation, { id: contentId, state });
  if (!data.updateIssue?.issue?.id) throw infrastructureError('GitHub did not confirm the Issue state.', 'GH_RESPONSE_INVALID');
  return data.updateIssue.issue.state;
}

export async function deleteKanbanItem(client, project, itemId, fallback = {}) {
  const item = project.normalizedItems.find(candidate => candidate.itemId === itemId);
  const target = item || fallback;
  if (!item && !target.contentId) {
    throw infrastructureError('Project item is unavailable and no linked content was cached.', 'PROJECT_ITEM_NOT_FOUND');
  }
  let issueClosed = false;
  if (target.contentType === 'issue' && target.contentId && target.contentState !== 'CLOSED') {
    await setIssueState(client, target.contentId, 'CLOSED');
    issueClosed = true;
  }
  if (item) {
    const mutation = `mutation($projectId:ID!, $itemId:ID!) {
      deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}) { deletedItemId }
    }`;
    const data = await client(mutation, { projectId: project.id, itemId });
    if (data.deleteProjectV2Item?.deletedItemId !== itemId) {
      throw infrastructureError('GitHub did not confirm Project item deletion.', 'GH_RESPONSE_INVALID');
    }
  }
  return { itemId, projectItemDeleted: Boolean(item), issueClosed };
}

function projectFields(project) {
  return new Map((project.fields?.nodes || []).map(field => [field.name, field]));
}

function operationKey(update, type, value) {
  const digest = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
  return `${update.itemId}:${type}:${digest}`;
}

function commentMarker(key) {
  return `<!-- mineprogress:comment:${key.split(':').at(-1)} -->`;
}

function evidenceSection(body, heading, nextHeading = null) {
  const startMatch = new RegExp(`^### ${heading}\\s*$`, 'imu').exec(body);
  if (!startMatch) return '';
  const start = startMatch.index + startMatch[0].length;
  const remainder = body.slice(start);
  const end = nextHeading ? new RegExp(`^### ${nextHeading}\\s*$`, 'imu').exec(remainder)?.index : -1;
  return remainder.slice(0, end === undefined || end < 0 ? undefined : end).trim();
}

function compactManagedProgress(body) {
  const normalized = String(body || '').replace(/<!--\s*mineprogress:comment:[^>]+-->/giu, '').trim();
  const heading = /^## Progress Update[^\r\n]*$/imu.exec(normalized)?.[0] || 'Managed progress update';
  const requirements = evidenceSection(normalized, 'Requirements', 'Results');
  const results = evidenceSection(normalized, 'Results');
  if (!requirements || !results) return '';
  const compact = [heading, requirements && `Requirements:\n${requirements}`, results && `Results:\n${results}`]
    .filter(Boolean).join('\n');
  return [...compact].slice(0, 2000).join('');
}

function managedEvidenceFact(body, { url = null, timestamp = null, source = 'github-comment' } = {}) {
  if (!String(body || '').match(/<!--\s*mineprogress:comment:[^>]+-->/iu) && source === 'github-comment') return null;
  const text = compactManagedProgress(body);
  if (!text) return null;
  const digest = crypto.createHash('sha256').update(`${source}\n${text}`).digest('hex').slice(0, 20);
  return { factId: `${source}:${digest}`, source, text, url, timestamp };
}

export async function readManagedEvidence(client, contentId) {
  let after = null;
  const facts = [];
  do {
    const query = `query($id:ID!, $after:String) {
      node(id:$id) {
        ... on Issue { comments(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { body url createdAt } } }
        ... on PullRequest { comments(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { body url createdAt } } }
      }
    }`;
    const data = await client(query, { id: contentId, after });
    const comments = data.node?.comments;
    if (!comments) return [];
    for (const comment of comments.nodes || []) {
      const fact = managedEvidenceFact(comment.body, { url: comment.url || null, timestamp: comment.createdAt || null });
      if (fact) facts.push(fact);
    }
    after = comments.pageInfo?.hasNextPage ? comments.pageInfo.endCursor : null;
  } while (after);
  return facts;
}

export function readManagedDraftEvidence(body, url = null) {
  const starts = [...String(body || '').matchAll(/^## Progress Update[^\r\n]*$/gimu)].map(match => match.index);
  return starts.map((start, index) => {
    const section = String(body).slice(start, starts[index + 1]);
    return managedEvidenceFact(section, { url, source: 'github-draft' });
  }).filter(Boolean);
}

export function prepareUpdateOperations(config, project, plan, {
  proposalBodyItemIds = [],
  repositoryReferences = []
} = {}) {
  const fields = projectFields(project);
  const items = new Map((project.normalizedItems || []).map(item => [item.itemId, item]));
  const proposalIds = new Set(proposalBodyItemIds);
  const repositories = new Map(repositoryReferences
    .map(reference => [reference.itemId, normalizePrimaryRepository(reference)])
    .filter(([, reference]) => reference));
  const operations = [];
  for (const update of plan.updates) {
    const item = items.get(update.itemId);
    const repository = repositories.get(update.itemId);
    const proposalWrite = proposalIds.has(update.itemId);
    if (repository && item?.contentType === 'issue' && !proposalWrite &&
        canManageRepositoryReference(item.body)) {
      const expected = upsertRepositoryReference(item.body, repository);
      if (expected !== item.body) operations.push({
        key: operationKey(update, 'repository-reference', expected),
        kind: 'repositoryReference',
        itemId: update.itemId,
        contentId: item.contentId,
        contentType: item.contentType,
        before: item.body || '',
        expected,
        value: { body: expected }
      });
    }
    if (update.status) {
      const { field, option } = statusOption(project, config, update.status);
      if (item?.status !== update.status) operations.push({
        key: operationKey(update, 'status', update.status),
        kind: 'status',
        itemId: update.itemId,
        fieldId: field.id,
        before: item?.status || null,
        expected: update.status,
        value: { singleSelectOptionId: option.id }
      });
      if (item?.contentType === 'issue' && item.contentId && item.contentState) {
        const terminal = config.kanban?.terminalStatuses?.includes(update.status);
        const expected = terminal ? 'CLOSED' : 'OPEN';
        if (item.contentState !== expected) operations.push({
          key: operationKey(update, 'issue-state', expected),
          kind: 'issueState',
          itemId: update.itemId,
          contentId: item.contentId,
          contentType: item.contentType,
          before: item.contentState,
          expected,
          value: { state: expected }
        });
      }
    }
    if (update.summary) {
      const field = fields.get(config.updateFieldName);
      if (!field) throw infrastructureError(`Project field not found: ${config.updateFieldName}`, 'PROJECT_FIELD_MISSING');
      if (item?.summary !== update.summary) operations.push({
        key: operationKey(update, 'summary', update.summary),
        kind: 'summary',
        itemId: update.itemId,
        fieldId: field.id,
        before: item?.summary || null,
        expected: update.summary,
        value: { text: update.summary }
      });
    }
    if (update.body) {
      if (!item?.contentId || !['issue', 'draft'].includes(item.contentType)) {
        throw infrastructureError('Project item does not support a managed body.', 'PROJECT_ITEM_BODY_UNSUPPORTED');
      }
      if (item.body !== update.body) {
        if (item.contentType === 'issue' && !proposalWrite) {
          throw infrastructureError('Issue body is immutable after its initial proposal.', 'ISSUE_BODY_IMMUTABLE');
        }
        if (item.contentType === 'draft' && !proposalWrite && !update.body.startsWith(item.body || '')) {
          throw infrastructureError('Draft body updates must append to the exact existing body.', 'DRAFT_BODY_APPEND_ONLY');
        }
        const kind = proposalWrite ? 'proposalBody' : 'draftAppend';
        const expected = item.contentType === 'issue' && proposalWrite && repository
          ? upsertRepositoryReference(update.body, repository)
          : update.body;
        operations.push({
          key: operationKey(update, kind, expected),
          kind,
          itemId: update.itemId,
          contentId: item.contentId,
          contentType: item.contentType,
          before: item.body || '',
          expected,
          value: { body: expected }
        });
      }
    }
    if (update.comment) {
      if (!item?.contentId || !['issue', 'pullRequest'].includes(item.contentType)) {
        throw infrastructureError('Project item does not support comments.', 'PROJECT_ITEM_COMMENT_UNSUPPORTED');
      }
      const key = operationKey(update, 'comment', update.comment);
      const marker = commentMarker(key);
      operations.push({
        key,
        kind: 'comment',
        itemId: update.itemId,
        contentId: item.contentId,
        contentType: item.contentType,
        before: null,
        expected: marker,
        value: { body: `${update.comment.trim()}\n\n${marker}` }
      });
    }
  }
  return { projectId: project.id, operations };
}

async function hasCommentMarker(client, contentId, marker) {
  let after = null;
  do {
    const query = `query($id:ID!, $after:String) {
      node(id:$id) {
        ... on Issue { comments(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { body } } }
        ... on PullRequest { comments(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { body } } }
      }
    }`;
    const data = await client(query, { id: contentId, after });
    const comments = data.node?.comments;
    if (!comments) throw infrastructureError('Comment subject is unavailable.', 'PROJECT_ITEM_COMMENT_UNSUPPORTED');
    if ((comments.nodes || []).some(comment => comment.body?.includes(marker))) return true;
    after = comments.pageInfo?.hasNextPage ? comments.pageInfo.endCursor : null;
  } while (after);
  return false;
}

export async function reconcilePreparedOperations(project, operations, { client } = {}) {
  const items = new Map((project.normalizedItems || []).map(item => [item.itemId, item]));
  const confirmed = [];
  const retryable = [];
  const conflicts = [];
  for (const operation of operations) {
    const item = items.get(operation.itemId);
    if (!item) {
      conflicts.push({ operation, actual: null, reason: 'Project item is unavailable.' });
      continue;
    }
    if (operation.kind === 'comment') {
      if (!client) {
        retryable.push(operation);
        continue;
      }
      if (await hasCommentMarker(client, operation.contentId, operation.expected)) confirmed.push(operation);
      else retryable.push(operation);
      continue;
    }
    const actual = operation.kind === 'status' ? item.status
      : operation.kind === 'summary' ? item.summary
        : ['proposalBody', 'draftAppend', 'repositoryReference'].includes(operation.kind) ? item.body
          : operation.kind === 'issueState' ? item.contentState : undefined;
    if (actual === operation.expected) confirmed.push(operation);
    else if (actual === operation.before) retryable.push(operation);
    else conflicts.push({ operation, actual, reason: 'Field changed after the plan was prepared.' });
  }
  return { confirmed, retryable, conflicts };
}

export async function applyPreparedOperations(client, projectId, operations) {
  if (!operations.length) return { applied: 0 };
  for (const operation of operations.filter(candidate =>
    ['proposalBody', 'draftAppend', 'repositoryReference'].includes(candidate.kind))) {
    const query = `query($id:ID!) { node(id:$id) {
      ... on Issue { body }
      ... on DraftIssue { body }
    } }`;
    const data = await client(query, { id: operation.contentId });
    if (data.node?.body !== operation.before) {
      throw infrastructureError('Content body changed after planning; refusing to overwrite it.', 'CONTENT_BODY_CONFLICT');
    }
    if (operation.kind === 'draftAppend' && !operation.expected.startsWith(data.node.body)) {
      throw infrastructureError('Draft body mutation is not append-only.', 'DRAFT_BODY_APPEND_ONLY');
    }
  }
  const hasProjectFields = operations.some(operation => ['status', 'summary'].includes(operation.kind));
  const definitions = hasProjectFields ? ['$projectId:ID!'] : [];
  const selections = [];
  const variables = hasProjectFields ? { projectId } : {};
  operations.forEach((operation, index) => {
    if (['status', 'summary'].includes(operation.kind)) {
      definitions.push(`$itemId${index}:ID!`, `$fieldId${index}:ID!`, `$value${index}:ProjectV2FieldValue!`);
      variables[`itemId${index}`] = operation.itemId;
      variables[`fieldId${index}`] = operation.fieldId;
      variables[`value${index}`] = operation.value;
      selections.push(`operation${index}:updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId${index},fieldId:$fieldId${index},value:$value${index}}) { projectV2Item { id } }`);
    } else if (operation.kind === 'issueState') {
      definitions.push(`$contentId${index}:ID!`, `$state${index}:IssueState!`);
      variables[`contentId${index}`] = operation.contentId;
      variables[`state${index}`] = operation.value.state;
      selections.push(`operation${index}:updateIssue(input:{id:$contentId${index},state:$state${index}}) { issue { id state } }`);
    } else {
      definitions.push(`$contentId${index}:ID!`, `$body${index}:String!`);
      variables[`contentId${index}`] = operation.contentId;
      variables[`body${index}`] = operation.value.body;
      if (operation.kind === 'proposalBody' && operation.contentType === 'issue') {
        selections.push(`operation${index}:updateIssue(input:{id:$contentId${index},body:$body${index}}) { issue { id } }`);
      } else if (operation.kind === 'repositoryReference' && operation.contentType === 'issue') {
        selections.push(`operation${index}:updateIssue(input:{id:$contentId${index},body:$body${index}}) { issue { id } }`);
      } else if (['proposalBody', 'draftAppend'].includes(operation.kind) && operation.contentType === 'draft') {
        selections.push(`operation${index}:updateProjectV2DraftIssue(input:{draftIssueId:$contentId${index},body:$body${index}}) { draftIssue { id } }`);
      } else if (operation.kind === 'comment') {
        selections.push(`operation${index}:addComment(input:{subjectId:$contentId${index},body:$body${index}}) { commentEdge { node { id } } }`);
      } else {
        throw infrastructureError(`Unsupported prepared operation: ${operation.kind}.`, 'UPDATE_OPERATION_INVALID');
      }
    }
  });
  const signature = definitions.length ? `(${definitions.join(',')})` : '';
  const mutation = `mutation${signature} { ${selections.join('\n')} }`;
  const data = await client(mutation, variables);
  for (let index = 0; index < operations.length; index++) {
    const payload = data[`operation${index}`];
    const confirmed = payload?.projectV2Item?.id || payload?.issue?.id || payload?.draftIssue?.id || payload?.commentEdge?.node?.id;
    if (!confirmed) {
      throw infrastructureError('GitHub did not confirm every prepared Project field update.', 'GH_RESPONSE_INVALID');
    }
  }
  return { applied: operations.length };
}

export async function applyUpdatePlan(config, client, plan, {
  alreadyApplied = [],
  onApplied = async () => {},
  proposalBodyItemIds = []
} = {}) {
  if (!plan.updates.length) return { applied: 0, operations: [...alreadyApplied] };
  const project = await readProject(config, client);
  const prepared = prepareUpdateOperations(config, project, plan, { proposalBodyItemIds });
  const completed = new Set(alreadyApplied);
  let applied = 0;
  for (const operation of prepared.operations) {
    if (completed.has(operation.key)) continue;
    await applyPreparedOperations(client, prepared.projectId, [operation]);
    completed.add(operation.key);
    applied++;
    await onApplied(operation.key);
  }
  return { applied, operations: [...completed] };
}
