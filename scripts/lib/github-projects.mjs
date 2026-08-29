import crypto from 'node:crypto';

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

const PROJECT_QUERY = `query($login:String!, $number:Int!, $after:String) {
  user(login:$login) { projectV2(number:$number) { ...ProjectData } }
  organization(login:$login) { projectV2(number:$number) { ...ProjectData } }
}
fragment ProjectData on ProjectV2 {
  id title url public
  fields(first:50) { nodes {
    ... on ProjectV2FieldCommon { id name }
    ... on ProjectV2SingleSelectField { id name options { id name } }
  } }
  items(first:100, after:$after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id isArchived
      content {
        ... on DraftIssue { title body }
        ... on Issue { title number repository { nameWithOwner } }
        ... on PullRequest { title number repository { nameWithOwner } }
      }
      fieldValues(first:20) { nodes {
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
        ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { id name } } }
      } }
    }
  }
}`;

function selectProject(data, ownerType) {
  return ownerType === 'organization' ? data.organization?.projectV2 : data.user?.projectV2;
}

export function normalizeProjectItem(item, config) {
  const fields = new Map((item.fieldValues?.nodes || [])
    .filter(value => value.field?.name)
    .map(value => [value.field.name, value]));
  return {
    itemId: item.id,
    title: item.content?.title || '(untitled draft)',
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
    const data = await client(PROJECT_QUERY, { login: config.owner, number: config.projectNumber, after });
    const page = selectProject(data, config.ownerType);
    if (!page) throw infrastructureError('Configured GitHub Project was not found.', 'PROJECT_NOT_FOUND');
    if (!combined) combined = { ...page, items: { nodes: [] } };
    combined.items.nodes.push(...(page.items?.nodes || []));
    after = page.items?.pageInfo?.hasNextPage ? page.items.pageInfo.endCursor : null;
  } while (after);
  combined.normalizedItems = combined.items.nodes.map(item => normalizeProjectItem(item, config));
  return combined;
}

export async function createDraftItem(config, client, title) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) throw Object.assign(new Error('A non-empty title is required.'), { code: 'CREATE_TITLE_REQUIRED' });
  if ([...normalizedTitle].length > 256) throw Object.assign(new Error('Title must not exceed 256 characters.'), { code: 'CREATE_TITLE_INVALID' });
  const project = await readProject(config, client);
  const mutation = `mutation($projectId:ID!, $title:String!) {
    addProjectV2DraftIssue(input:{projectId:$projectId,title:$title}) { projectItem { id } }
  }`;
  const data = await client(mutation, { projectId: project.id, title: normalizedTitle });
  return { itemId: data.addProjectV2DraftIssue?.projectV2Item?.id || data.addProjectV2DraftIssue?.projectItem?.id, title: normalizedTitle };
}

function splitRepository(nameWithOwner) {
  const parts = String(nameWithOwner || '').split('/');
  if (parts.length !== 2 || parts.some(part => !part)) {
    throw infrastructureError('defaultRepository must use owner/name format.', 'CONFIG_INVALID');
  }
  return { owner: parts[0], name: parts[1] };
}

export async function readRepository(client, nameWithOwner) {
  const { owner, name } = splitRepository(nameWithOwner);
  const query = `query($owner:String!, $name:String!) { repository(owner:$owner,name:$name) { id nameWithOwner visibility } }`;
  const data = await client(query, { owner, name });
  if (!data.repository) throw infrastructureError('Configured default repository was not found.', 'REPOSITORY_NOT_FOUND');
  return data.repository;
}

export function selectCreationRoute(config, projectVisibility, repositoryVisibility) {
  if (!config.defaultRepository) return { route: 'draft', key: 'no_default_repository' };
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
  if (!config.defaultRepository) {
    return { route: 'draft', key: 'no_default_repository', projectVisibility: project.public ? 'public' : 'private', repositoryVisibility: null, repository: null };
  }
  const repository = await readRepository(client, config.defaultRepository);
  return {
    ...selectCreationRoute(config, project.public ? 'public' : 'private', repository.visibility.toLowerCase()),
    repository: repository.nameWithOwner,
    projectId: project.id,
    repositoryId: repository.id
  };
}

export async function createKanbanItem(config, client, title) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) throw Object.assign(new Error('A non-empty title is required.'), { code: 'CREATE_TITLE_REQUIRED' });
  if ([...normalizedTitle].length > 256) throw Object.assign(new Error('Title must not exceed 256 characters.'), { code: 'CREATE_TITLE_INVALID' });
  const project = await readProject(config, client);
  const policy = await inspectCreationPolicy(config, client, project);
  if (policy.route === 'draft') {
    const mutation = `mutation($projectId:ID!, $title:String!) {
      addProjectV2DraftIssue(input:{projectId:$projectId,title:$title}) { projectV2Item { id } }
    }`;
    const data = await client(mutation, { projectId: project.id, title: normalizedTitle });
    const itemId = data.addProjectV2DraftIssue?.projectV2Item?.id;
    if (!itemId) throw infrastructureError('GitHub did not return the created draft item id.', 'GH_RESPONSE_INVALID');
    return { itemId, title: normalizedTitle, kind: 'draft', policy };
  }
  const createMutation = `mutation($repositoryId:ID!, $title:String!) {
    createIssue(input:{repositoryId:$repositoryId,title:$title}) { issue { id number url } }
  }`;
  const created = await client(createMutation, { repositoryId: policy.repositoryId, title: normalizedTitle });
  const issue = created.createIssue?.issue;
  if (!issue?.id) throw infrastructureError('GitHub did not return the created issue id.', 'GH_RESPONSE_INVALID');
  const addMutation = `mutation($projectId:ID!, $contentId:ID!) {
    addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}) { item { id } }
  }`;
  const added = await client(addMutation, { projectId: project.id, contentId: issue.id });
  const itemId = added.addProjectV2ItemById?.item?.id;
  if (!itemId) throw infrastructureError(`Issue ${issue.url || issue.number} was created but could not be added to the Project.`, 'PROJECT_ADD_ITEM_FAILED');
  return {
    itemId,
    title: normalizedTitle,
    kind: 'issue',
    issueNumber: issue.number,
    issueUrl: issue.url,
    policy
  };
}

function projectFields(project) {
  return new Map((project.fields?.nodes || []).map(field => [field.name, field]));
}

function operationKey(update, type, value) {
  const digest = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
  return `${update.itemId}:${type}:${digest}`;
}

export async function applyUpdatePlan(config, client, plan, { alreadyApplied = [], onApplied = async () => {} } = {}) {
  if (!plan.updates.length) return { applied: 0, operations: [...alreadyApplied] };
  const project = await readProject(config, client);
  const fields = projectFields(project);
  const completed = new Set(alreadyApplied);
  let applied = 0;
  for (const update of plan.updates) {
    const operations = [];
    if (update.status) {
      const field = fields.get(config.statusFieldName);
      if (!field) throw infrastructureError(`Project field not found: ${config.statusFieldName}`, 'PROJECT_FIELD_MISSING');
      const option = field.options?.find(candidate => candidate.name === update.status);
      if (!option) throw infrastructureError(`Status option not found: ${update.status}`, 'PROJECT_STATUS_OPTION_MISSING');
      operations.push({ key: operationKey(update, 'status', update.status), fieldId: field.id, value: { singleSelectOptionId: option.id } });
    }
    if (update.summary) {
      const field = fields.get(config.updateFieldName);
      if (!field) throw infrastructureError(`Project field not found: ${config.updateFieldName}`, 'PROJECT_FIELD_MISSING');
      operations.push({ key: operationKey(update, 'summary', update.summary), fieldId: field.id, value: { text: update.summary } });
    }
    for (const operation of operations) {
      if (completed.has(operation.key)) continue;
      const mutation = `mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $value:ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:$value}) { projectV2Item { id } }
      }`;
      await client(mutation, { projectId: project.id, itemId: update.itemId, fieldId: operation.fieldId, value: operation.value });
      completed.add(operation.key);
      applied++;
      await onApplied(operation.key);
    }
  }
  return { applied, operations: [...completed] };
}
