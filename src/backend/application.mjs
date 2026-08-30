import fs from 'node:fs/promises';
import path from 'node:path';
import { configPath, createConfig, creationRepository, detectTerminalStatuses, loadConfig, saveConfig, selectDefaultStatus } from './config.mjs';
import { suggestBindings } from './check.mjs';
import {
  applyPreparedOperations,
  createTextField,
  createKanbanItem,
  deleteKanbanItem,
  inspectCreationPolicy,
  prepareUpdateOperations,
  projectStatusOptions,
  readProject,
  reconcilePreparedOperations
} from './github-projects.mjs';
import { logError, resolveError, unresolvedErrors } from './errors.mjs';
import { withSessionLock } from './lock.mjs';
import { readProjectMetadata, updateProjectMetadata } from './metadata.mjs';
import {
  beginUpdate,
  beginSubmissionAttempt,
  bindItem,
  completeUpdate,
  completeSubmission,
  confirmSubmissionResponse,
  openSession,
  pendingJournal,
  readState,
  requireCommandAuthorization,
  retryExhaustedUpdate,
  storePendingPlan,
  unbindItem,
  writeState
} from './state.mjs';
import { validatePlan, validateReview } from './validation.mjs';

function requireRuntime(runtime) {
  if (!runtime?.dataDir) throw Object.assign(new Error('Backend runtime requires dataDir.'), { code: 'DATA_DIR_REQUIRED' });
  if (!runtime?.resourceRoot) throw Object.assign(new Error('Backend runtime requires resourceRoot.'), { code: 'RESOURCE_ROOT_REQUIRED' });
  if (typeof runtime?.githubClient !== 'function') {
    throw Object.assign(new Error('Backend runtime requires a GitHub client provider.'), { code: 'GITHUB_CLIENT_REQUIRED' });
  }
  return runtime;
}

function pluginConfig(dataDir, runtime) {
  return loadConfig(configPath(runtime.environment || {}, runtime.resourceRoot, dataDir));
}

export function parseCommandArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (['all', 'delete', 'json', 'confirm', 'no-repository'].includes(key)) flags[key] = true;
    else flags[key] = argv[++index];
  }
  return { positional, flags };
}

function requiredSession(flags, runtime) {
  const sessionId = flags.session || runtime.sessionId;
  if (!sessionId) throw Object.assign(new Error('A sessionId is required.'), { code: 'SESSION_ID_REQUIRED' });
  return sessionId;
}

async function readJson(file) {
  if (!file) throw Object.assign(new Error('A JSON file path is required.'), { code: 'INPUT_FILE_REQUIRED' });
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readOptionalText(file) {
  return file ? fs.readFile(file, 'utf8') : '';
}

export function parseProjectUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw Object.assign(new Error('Project URL must be a valid GitHub URL.'), { code: 'PROJECT_URL_INVALID' });
  }
  if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) {
    throw Object.assign(new Error('Project URL must use github.com.'), { code: 'PROJECT_URL_INVALID' });
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const ownerType = parts[0] === 'users' ? 'user' : parts[0] === 'orgs' ? 'organization' : null;
  const projectNumber = Number(parts[3]);
  if (!ownerType || parts[2] !== 'projects' || !Number.isInteger(projectNumber) || projectNumber < 1) {
    throw Object.assign(new Error('Expected https://github.com/users/<owner>/projects/<number> or /orgs/...'), { code: 'PROJECT_URL_INVALID' });
  }
  return { owner: parts[1], ownerType, projectNumber };
}

function initializationConfig(flags) {
  if (!flags['project-url']) throw Object.assign(new Error('Pass --project-url <GitHub Project URL>.'), { code: 'PROJECT_URL_REQUIRED' });
  if (flags.repository && flags['no-repository']) {
    throw Object.assign(new Error('Use either --repository or --no-repository, not both.'), { code: 'CONFIG_INVALID' });
  }
  return createConfig({
    ...parseProjectUrl(flags['project-url']),
    creation: { repository: flags.repository || '' },
    statusFieldName: flags['status-field'] || 'Status',
    updateFieldName: flags['update-field'] || 'Update',
    kanban: { defaultStatus: flags['default-status'] || '', terminalStatuses: [] }
  });
}

export function resolveInitializationCreationRepository(flags, project) {
  const candidates = [...new Map((project.repositories?.nodes || [])
    .filter(repository => repository?.nameWithOwner)
    .map(repository => [repository.nameWithOwner, {
      nameWithOwner: repository.nameWithOwner,
      visibility: repository.visibility?.toLowerCase() || null
    }])).values()];
  if (flags.repository) {
    return { repository: flags.repository, source: 'explicit', candidates, selectionRequired: false };
  }
  if (flags['no-repository']) {
    return { repository: '', source: 'explicit-none', candidates, selectionRequired: false };
  }
  if (candidates.length === 1) {
    return { repository: candidates[0].nameWithOwner, source: 'sole-linked', candidates, selectionRequired: false };
  }
  return {
    repository: '',
    source: candidates.length ? null : 'none',
    candidates,
    selectionRequired: candidates.length > 1
  };
}

async function inspectInitialization(dataDir, flags, runtime) {
  let config = initializationConfig(flags);
  const client = await runtime.githubClient();
  const project = await readProject(config, client);
  const repositorySelection = resolveInitializationCreationRepository(flags, project);
  config = createConfig({
    ...config,
    creation: { ...config.creation, repository: repositorySelection.repository }
  });
  const fields = project.fields?.nodes || [];
  const statusField = fields.find(field => field.name === config.statusFieldName);
  const updateField = fields.find(field => field.name === config.updateFieldName);
  const availableStatuses = (statusField?.options || []).map(option => option.name);
  const requestedDefaultStatus = config.kanban.defaultStatus;
  if (requestedDefaultStatus && !availableStatuses.includes(requestedDefaultStatus)) {
    throw Object.assign(new Error(`Default status is not available in the Project: ${requestedDefaultStatus}`), { code: 'PROJECT_DEFAULT_STATUS_INVALID' });
  }
  config = createConfig({
    ...config,
    kanban: {
      ...config.kanban,
      defaultStatus: requestedDefaultStatus || selectDefaultStatus(availableStatuses),
      terminalStatuses: detectTerminalStatuses(availableStatuses)
    }
  });
  const creationPolicy = repositorySelection.selectionRequired
    ? null
    : await inspectCreationPolicy(config, client, project);
  return {
    config,
    project,
    availableStatuses,
    defaultStatusSource: requestedDefaultStatus ? 'explicit' : 'detected',
    creationPolicy,
    repositorySelection,
    statusFieldFound: Boolean(statusField),
    updateFieldFound: Boolean(updateField),
    configTarget: configPath(runtime.environment || {}, runtime.resourceRoot, dataDir),
    client
  };
}

async function initCommand(dataDir, flags, positional, runtime) {
  if (positional.length) {
    throw Object.assign(new Error('Run init without a preview or apply action.'), { code: 'INIT_ACTION_INVALID' });
  }
  const inspection = await inspectInitialization(dataDir, flags, runtime);
  const result = {
    project: inspection.project.title,
    owner: inspection.config.owner,
    ownerType: inspection.config.ownerType,
    projectNumber: inspection.config.projectNumber,
    creationRepository: creationRepository(inspection.config) || null,
    creationRepositorySource: inspection.repositorySelection.source,
    linkedRepositoryCandidates: inspection.repositorySelection.candidates,
    projectVisibility: inspection.creationPolicy?.projectVisibility || (inspection.project.public ? 'public' : 'private'),
    repositoryVisibility: inspection.creationPolicy?.repositoryVisibility || null,
    creationRoute: inspection.creationPolicy?.route || null,
    availableStatuses: inspection.availableStatuses,
    defaultStatus: inspection.config.kanban.defaultStatus || null,
    defaultStatusSource: inspection.defaultStatusSource,
    terminalStatuses: inspection.config.kanban.terminalStatuses,
    statusFieldFound: inspection.statusFieldFound,
    configTarget: inspection.configTarget
  };
  if (inspection.repositorySelection.selectionRequired) {
    return {
      outcome: 'repository_selection_required',
      message: 'GitHub public GraphQL exposes linked repositories but not the Project default. Select the Issue repository with --repository <owner/name>, or explicitly choose draft-only creation with --no-repository.',
      ...result
    };
  }
  if (!inspection.statusFieldFound || !inspection.availableStatuses.length) {
    throw Object.assign(new Error(`Create a populated single-select field named ${inspection.config.statusFieldName} in the Project, then rerun init.`), { code: 'PROJECT_STATUS_FIELD_REQUIRED' });
  }
  if (!inspection.updateFieldFound) {
    await createTextField(inspection.client, inspection.project.id, inspection.config.updateFieldName);
  }
  await saveConfig(inspection.configTarget, inspection.config);
  await updateProjectMetadata(dataDir, inspection.config, {
    availableStatuses: inspection.availableStatuses,
    creationPolicy: {
      repository: inspection.creationPolicy.repository,
      projectVisibility: inspection.creationPolicy.projectVisibility,
      repositoryVisibility: inspection.creationPolicy.repositoryVisibility,
      route: inspection.creationPolicy.route,
      key: inspection.creationPolicy.key
    }
  });
  return {
    outcome: 'initialized',
    ...result,
    updateFieldFound: true,
    updateFieldCreated: !inspection.updateFieldFound
  };
}

async function createCommand(dataDir, flags, positional, runtime) {
  const sessionId = requiredSession(flags, runtime);
  const title = flags.title || positional.join(' ');
  const initial = await readState(dataDir, sessionId);
  if (!initial) throw Object.assign(new Error('Thread cache does not exist.'), { code: 'STATE_NOT_FOUND' });
  requireCommandAuthorization(initial, 'create');
  const config = await pluginConfig(dataDir, runtime);
  const body = await readOptionalText(flags['body-file']);
  const item = await createKanbanItem(config, await runtime.githubClient(), title, body);
  await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    const consumeAuthorization = requireCommandAuthorization(state, 'create');
    bindItem(state, item, { source: 'create' });
    consumeAuthorization();
    await writeState(dataDir, state);
  });
  await updateProjectMetadata(dataDir, config, { creationPolicy: {
    repository: item.policy.repository,
    projectVisibility: item.policy.projectVisibility,
    repositoryVisibility: item.policy.repositoryVisibility,
    route: item.policy.route,
    key: item.policy.key
  } });
  return {
    created: {
      itemId: item.itemId,
      title: item.title,
      kind: item.kind,
      issueNumber: item.issueNumber || null,
      issueUrl: item.issueUrl || null,
      route: item.policy.route,
      repository: item.policy.repository,
      projectVisibility: item.policy.projectVisibility,
      repositoryVisibility: item.policy.repositoryVisibility,
      defaultStatus: item.defaultStatus
    },
    bound: true
  };
}

async function bindCommand(dataDir, flags, positional, runtime) {
  const sessionId = requiredSession(flags, runtime);
  const itemId = flags.item || positional[0];
  if (!itemId) throw Object.assign(new Error('Pass --item <Project item id>.'), { code: 'ITEM_ID_REQUIRED' });
  const initial = await readState(dataDir, sessionId);
  if (!initial) throw Object.assign(new Error('Thread cache does not exist.'), { code: 'STATE_NOT_FOUND' });
  requireCommandAuthorization(initial, 'bind');
  const config = await pluginConfig(dataDir, runtime);
  const project = await readProject(config, await runtime.githubClient());
  const item = project.normalizedItems.find(candidate => candidate.itemId === itemId);
  if (!item) throw Object.assign(new Error('Item is not in the configured Project.'), { code: 'PROJECT_ITEM_NOT_FOUND' });
  const changed = await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    const consumeAuthorization = requireCommandAuthorization(state, 'bind');
    const bound = bindItem(state, item, { source: 'bind' });
    consumeAuthorization();
    await writeState(dataDir, state);
    return bound;
  });
  return { changed, item };
}

async function unbindCommand(dataDir, flags, positional, runtime) {
  const sessionId = requiredSession(flags, runtime);
  const itemId = flags.item || positional[0];
  if (!itemId) throw Object.assign(new Error('Pass --item <Project item id>.'), { code: 'ITEM_ID_REQUIRED' });
  const initial = await readState(dataDir, sessionId);
  if (!initial) throw Object.assign(new Error('Thread cache does not exist.'), { code: 'STATE_NOT_FOUND' });
  requireCommandAuthorization(initial, 'unbind');
  let deletion = null;
  if (flags.delete) {
    const config = await pluginConfig(dataDir, runtime);
    const client = await runtime.githubClient();
    const project = await readProject(config, client);
    const binding = initial.boundItems.find(item => item.itemId === itemId) || {};
    deletion = await deleteKanbanItem(client, project, itemId, binding);
  }
  const changed = await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    const consumeAuthorization = requireCommandAuthorization(state, 'unbind');
    const unbound = unbindItem(state, itemId);
    consumeAuthorization();
    await writeState(dataDir, state);
    return unbound;
  });
  return { changed, itemId, deletion };
}

async function checkCommand(dataDir, flags, runtime) {
  const sessionId = requiredSession(flags, runtime);
  const state = await readState(dataDir, sessionId);
  if (!state) throw Object.assign(new Error('Thread cache does not exist.'), { code: 'STATE_NOT_FOUND' });
  const config = await pluginConfig(dataDir, runtime);
  const client = await runtime.githubClient();
  const project = await readProject(config, client);
  const availableStatuses = projectStatusOptions(project, config).map(option => option.name);
  const creationPolicy = await inspectCreationPolicy(config, client, project);
  await updateProjectMetadata(dataDir, config, {
    availableStatuses,
    creationPolicy: {
      repository: creationPolicy.repository,
      projectVisibility: creationPolicy.projectVisibility,
      repositoryVisibility: creationPolicy.repositoryVisibility,
      route: creationPolicy.route,
      key: creationPolicy.key
    }
  });
  return {
    availableStatuses,
    defaultStatus: config.kanban.defaultStatus || null,
    terminalStatuses: config.kanban.terminalStatuses,
    defaultStatusAvailable: availableStatuses.includes(config.kanban.defaultStatus),
    creationPolicy: {
      repository: creationPolicy.repository,
      projectVisibility: creationPolicy.projectVisibility,
      repositoryVisibility: creationPolicy.repositoryVisibility,
      route: creationPolicy.route
    },
    ...suggestBindings(state.boundItems, project.normalizedItems, {
      terminalStatuses: config.kanban.terminalStatuses,
      availableStatuses
    })
  };
}

async function prepareUpdate(dataDir, sessionId, runtime) {
  const setup = await withSessionLock(dataDir, sessionId, async () => {
    const { state } = await openSession(dataDir, sessionId);
    if (state.pendingPlan?.attempts?.length) {
      return { result: { outcome: 'submission_unverified', reason: 'Verify the earlier submission with update submit before revising the plan.' } };
    }
    const run = beginUpdate(state);
    if (!run) {
      if (state.pendingPlan) {
        return { result: { outcome: 'pending_submission', updates: state.pendingPlan.plan.updates.length, throughSequence: state.pendingPlan.throughSequence } };
      }
      return { result: { outcome: 'noop', reason: 'No context exists after the last planned update.' } };
    }
    if (run.exhausted) {
      return { result: { outcome: 'exhausted', runId: run.runId, errorId: run.exhaustionErrorId, reason: 'Content attempts are suspended. Use update retry only after the user explicitly requests another run.' } };
    }
    if (run.approvedReview?.decision === 'approve' && run.stagedPlan) {
      return { result: { outcome: 'resume_apply', sessionId, runId: run.runId, reason: 'Store the already approved consolidated plan with update apply; no new review is required.' } };
    }
    if (!state.boundItems.length) {
      completeUpdate(state, run.runId);
      await writeState(dataDir, state);
      return { result: { outcome: 'noop', reason: 'No items are bound; checkpoint advanced.' } };
    }
    await writeState(dataDir, state);
    return { runId: run.runId };
  });
  if (setup.result) return setup.result;
  const config = await pluginConfig(dataDir, runtime);
  const project = await readProject(config, await runtime.githubClient());
  const availableStatuses = projectStatusOptions(project, config).map(option => option.name);
  await updateProjectMetadata(dataDir, config, { availableStatuses });
  const state = await withSessionLock(dataDir, sessionId, async () => {
    const latest = await readState(dataDir, sessionId);
    if (!latest?.activeUpdate || latest.activeUpdate.runId !== setup.runId) {
      throw Object.assign(new Error('The background update changed while Project data was loading.'), { code: 'UPDATE_RUN_MISMATCH' });
    }
    if (!latest.boundItems.length) {
      completeUpdate(latest, setup.runId);
      await writeState(dataDir, latest);
      return null;
    }
    latest.activeUpdate.projectSnapshot = {
      id: project.id,
      fields: project.fields,
      normalizedItems: project.normalizedItems
    };
    await writeState(dataDir, latest);
    return latest;
  });
  if (!state) return { outcome: 'noop', reason: 'No items remain bound; checkpoint advanced.' };
  const run = state.activeUpdate;
  const boundItems = validationBoundItems(state, run, project.normalizedItems);
  const promptNames = run.useThreadHistory
    ? [...new Set(boundItems.filter(item => item.backfillRequested)
      .map(item => item.bindingSource === 'create' ? 'create' : 'bind'))]
    : ['update'];
  const prompt = (await Promise.all(promptNames.map(async name =>
    fs.readFile(path.join(runtime.resourceRoot, 'prompts', `${name}.md`), 'utf8')))).join('\n\n');
  const model = run.useThreadHistory && boundItems.some(item => item.backfillRequested && item.bindingSource === 'create')
    ? config.models.create : config.models.update;
  return {
    outcome: 'generate_and_review',
    sessionId,
    runId: run.runId,
    attempt: run.attempt + 1,
    maxAttempts: config.update.maxReviewAttempts,
    model,
    reviewModel: config.models.review,
    preferFastMode: config.models.preferFastMode,
    useThreadHistory: Boolean(run.useThreadHistory),
    prompt,
    existingPlan: state.pendingPlan?.plan || { updates: [] },
    availableStatuses,
    promptNames,
    planningDate: new Date().toISOString().slice(0, 10),
    allowedOutput: { updates: [{
      itemId: 'bound-id',
      status: 'exact available status name or null',
      summary: 'concise Project field text or null',
      body: 'one-time created-item proposal, complete append-only Draft body, queued proposal copy, or null',
      comment: 'dated append-only Issue progress entry or null'
    }] },
    boundItems,
    context: pendingJournal(state).filter(event => event.sequence <= run.toSequence)
  };
}

function validationBoundItems(state, run, projectItems) {
  const boundIds = new Set(state.boundItems.map(item => item.itemId));
  const bindings = new Map(state.boundItems.map(item => [item.itemId, item]));
  const pendingBodyKinds = new Map((state.pendingPlan?.operations || [])
    .filter(operation => ['proposalBody', 'draftAppend'].includes(operation.kind))
    .map(operation => [operation.itemId, operation.kind]));
  return projectItems.filter(item => boundIds.has(item.itemId)).map(item => {
    const binding = bindings.get(item.itemId);
    const backfillRequested = Boolean(run.useThreadHistory &&
      (binding?.backfillRevision || 1) > (state.fullContextPlannedRevision || 0) &&
      (binding?.backfillRevision || 1) <= run.fullContextRevision);
    return {
      ...item,
      bindingSource: binding?.bindingSource || 'bind',
      backfillRequested,
      proposalWritable: Boolean(backfillRequested && binding?.bindingSource === 'create' && !binding.proposalInitialized),
      pendingBodyKind: pendingBodyKinds.get(item.itemId) || null
    };
  });
}

async function exhaustIfNeeded(dataDir, state, config, stage, message) {
  if (state.activeUpdate.attempt < config.update.maxReviewAttempts) return false;
  const event = await logError(dataDir, {
    sessionId: state.sessionId,
    updateRunId: state.activeUpdate.runId,
    stage,
    errorCode: 'REVIEW_EXHAUSTED',
    message
  });
  state.activeUpdate.exhausted = true;
  state.activeUpdate.exhaustedAt = new Date().toISOString();
  state.activeUpdate.exhaustionErrorId = event.errorId;
  return true;
}

async function stageUpdate(dataDir, sessionId, flags, runtime) {
  const config = await pluginConfig(dataDir, runtime);
  const plan = await readJson(flags.plan);
  const metadata = await readProjectMetadata(dataDir, config);
  if (!metadata?.availableStatuses?.length) {
    throw Object.assign(new Error('Kanban statuses are not cached; run check or update prepare first.'), { code: 'KANBAN_STATUS_UNKNOWN' });
  }
  return withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    if (!state?.activeUpdate) throw Object.assign(new Error('No update run is active.'), { code: 'UPDATE_NOT_ACTIVE' });
    if (state.pendingPlan?.attempts?.length) {
      return { accepted: false, paused: true, errors: ['An earlier submission is still unverified.'] };
    }
    if (state.activeUpdate.approvedReview) {
      throw Object.assign(new Error('The staged plan is already approved; resume update apply.'), { code: 'UPDATE_ALREADY_APPROVED' });
    }
    if (state.activeUpdate.attempt >= config.update.maxReviewAttempts) {
      return { accepted: false, exhausted: true, attempt: state.activeUpdate.attempt, errors: ['Maximum content attempts already reached.'] };
    }
    state.activeUpdate.attempt++;
    const incrementalNoop = !state.activeUpdate.useThreadHistory &&
      Array.isArray(plan?.updates) && plan.updates.length === 0;
    const validationItems = validationBoundItems(
      state,
      state.activeUpdate,
      state.activeUpdate.projectSnapshot.normalizedItems
    );
    const report = validatePlan(plan, {
      boundItems: validationItems,
      allowedStatuses: metadata.availableStatuses,
      maxCharacters: config.update.maxSummaryCharacters,
      maxWords: config.update.maxSummaryWords,
      maxBodyCharacters: config.update.maxBodyCharacters,
      maxCommentCharacters: config.update.maxCommentCharacters,
      existingPlan: incrementalNoop ? { updates: [] } : state.pendingPlan?.plan || { updates: [] }
    });
    if (!report.valid) {
      state.activeUpdate.stagedPlan = null;
      const exhausted = await exhaustIfNeeded(dataDir, state, config, 'static-validation', report.errors.join(' '));
      await writeState(dataDir, state);
      return { accepted: false, exhausted, attempt: state.activeUpdate.attempt, errors: report.errors };
    }
    if (incrementalNoop) {
      const runId = state.activeUpdate.runId;
      const attempt = state.activeUpdate.attempt;
      const pendingRetained = Boolean(state.pendingPlan);
      completeUpdate(state, runId);
      await writeState(dataDir, state);
      return { accepted: true, noop: true, pendingRetained, attempt, planningCheckpointAdvanced: true };
    }
    const itemsById = new Map(validationItems.map(item => [item.itemId, item]));
    state.activeUpdate.proposalBodyItemIds = plan.updates
      .filter(update => update.body && (itemsById.get(update.itemId)?.proposalWritable ||
        itemsById.get(update.itemId)?.pendingBodyKind === 'proposalBody'))
      .map(update => update.itemId);
    state.activeUpdate.stagedPlan = plan;
    state.activeUpdate.staticReport = report;
    await writeState(dataDir, state);
    return {
      accepted: true,
      attempt: state.activeUpdate.attempt,
      reviewModel: config.models.review,
      reviewPromptPath: path.join(runtime.resourceRoot, 'prompts', 'review.md'),
      staticReport: report,
      plan
    };
  });
}

async function applyUpdate(dataDir, sessionId, flags, runtime) {
  const config = await pluginConfig(dataDir, runtime);
  const initial = await readState(dataDir, sessionId);
  if (!initial?.activeUpdate?.stagedPlan) throw Object.assign(new Error('No statically valid plan is staged.'), { code: 'PLAN_NOT_STAGED' });
  const review = initial.activeUpdate.approvedReview || await readJson(flags.review);
  const projectSnapshot = initial.activeUpdate.projectSnapshot || await readProject(config, await runtime.githubClient());
  return withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    if (!state?.activeUpdate?.stagedPlan) throw Object.assign(new Error('No statically valid plan is staged.'), { code: 'PLAN_NOT_STAGED' });
    if (state.pendingPlan?.attempts?.length) {
      return { applied: false, paused: true, errors: ['An earlier submission is still unverified.'] };
    }
    const reviewReport = validateReview(review);
    if (!reviewReport.valid) {
      state.activeUpdate.stagedPlan = null;
      const exhausted = await exhaustIfNeeded(dataDir, state, config, 'review-output', reviewReport.errors.join(' '));
      await writeState(dataDir, state);
      return { applied: false, exhausted, errors: reviewReport.errors };
    }
    if (review.decision === 'reject') {
      state.activeUpdate.stagedPlan = null;
      const exhausted = await exhaustIfNeeded(dataDir, state, config, 'semantic-review', review.reason);
      await writeState(dataDir, state);
      return { applied: false, exhausted, errors: [review.reason] };
    }
    const runId = state.activeUpdate.runId;
    state.activeUpdate.approvedReview = review;
    await writeState(dataDir, state);
    const submission = prepareUpdateOperations(
      config,
      state.activeUpdate.projectSnapshot || projectSnapshot,
      state.activeUpdate.stagedPlan,
      { proposalBodyItemIds: state.activeUpdate.proposalBodyItemIds || [] }
    );
    const pending = storePendingPlan(state, runId, state.activeUpdate.stagedPlan, submission, review);
    await writeState(dataDir, state);
    return {
      planned: true,
      queuedUpdates: pending?.plan.updates.length || 0,
      queuedOperations: pending?.operations.length || 0,
      planningCheckpointAdvanced: true
    };
  });
}

async function sendPendingOperations(dataDir, state, operations, runtime) {
  const attempt = beginSubmissionAttempt(state, operations.map(operation => operation.key));
  await writeState(dataDir, state);
  const result = await applyPreparedOperations(await runtime.githubClient(), state.pendingPlan.projectId, operations);
  confirmSubmissionResponse(state, attempt.attemptId);
  await writeState(dataDir, state);
  return result;
}

export async function reconcilePendingUpdate(dataDir, sessionId, { retry = true } = {}, runtime) {
  const state = await readState(dataDir, sessionId);
  if (!state) return { submitted: false, reason: 'Thread cache does not exist.' };
  if (!state.pendingPlan) return { submitted: false, reason: 'No reviewed plan is pending.' };
  requireRuntime(runtime);
  const config = await pluginConfig(dataDir, runtime);
  const client = await runtime.githubClient();
  let project = await readProject(config, client);
  let report = await reconcilePreparedOperations(project, state.pendingPlan.operations, { client });
  if (retry && report.retryable.length) {
    await sendPendingOperations(dataDir, state, report.retryable, runtime);
    project = await readProject(config, client);
    report = await reconcilePreparedOperations(project, state.pendingPlan.operations, { client });
  }
  if (!report.retryable.length && !report.conflicts.length) {
    const writeOperations = report.confirmed.length;
    completeSubmission(state);
    await writeState(dataDir, state);
    return { submitted: true, verified: true, writeOperations, checkpointAdvanced: true };
  }
  state.pendingPlan.lastReconciliation = {
    checkedAt: new Date().toISOString(),
    confirmed: report.confirmed.map(operation => operation.key),
    retryable: report.retryable.map(operation => operation.key),
    conflicts: report.conflicts.map(({ operation }) => operation.key)
  };
  await writeState(dataDir, state);
  if (report.conflicts.length && !state.pendingPlan.conflictLoggedAt) {
    await logError(dataDir, {
      sessionId,
      stage: 'submission-reconciliation',
      errorCode: 'SUBMISSION_CONFLICT',
      message: `${report.conflicts.length} pending Project field operation(s) conflict with external changes.`
    });
    state.pendingPlan.conflictLoggedAt = new Date().toISOString();
    await writeState(dataDir, state);
  }
  return {
    submitted: false,
    verified: false,
    confirmed: report.confirmed.length,
    retryable: report.retryable.length,
    conflicts: report.conflicts.length
  };
}

export async function submitPendingUpdate(dataDir, sessionId, { verify = true } = {}, runtime) {
  const state = await readState(dataDir, sessionId);
  if (!state) return { submitted: false, reason: 'Thread cache does not exist.' };
  if (!state.pendingPlan) return { submitted: false, reason: 'No reviewed plan is pending.' };
  if (state.pendingPlan.attempts?.length) {
    if (verify) return reconcilePendingUpdate(dataDir, sessionId, {}, runtime);
    return { submitted: false, verified: false, reason: 'An earlier submission is still unverified.', queueRetained: true };
  }
  const result = await sendPendingOperations(dataDir, state, state.pendingPlan.operations, runtime);
  if (!verify) {
    return { submitted: true, verified: false, fieldUpdates: result.applied, queueRetained: true };
  }
  return reconcilePendingUpdate(dataDir, sessionId, { retry: false }, runtime);
}

async function updateCommand(dataDir, flags, positional, runtime) {
  const sessionId = requiredSession(flags, runtime);
  const action = positional[0] || 'prepare';
  if (action === 'prepare') return prepareUpdate(dataDir, sessionId, runtime);
  if (action === 'retry') {
    const state = await readState(dataDir, sessionId);
    if (!state) throw Object.assign(new Error('Thread cache does not exist.'), { code: 'STATE_NOT_FOUND' });
    const consumeAuthorization = requireCommandAuthorization(state, 'update_retry');
    retryExhaustedUpdate(state);
    consumeAuthorization();
    await writeState(dataDir, state);
    return prepareUpdate(dataDir, sessionId, runtime);
  }
  if (action === 'stage') return stageUpdate(dataDir, sessionId, flags, runtime);
  if (action === 'apply') return applyUpdate(dataDir, sessionId, flags, runtime);
  if (action === 'submit') return submitPendingUpdate(dataDir, sessionId, {}, runtime);
  throw Object.assign(new Error(`Unknown update action: ${action}`), { code: 'UPDATE_ACTION_INVALID' });
}

async function statusCommand(dataDir, flags, positional, runtime) {
  if (positional[0] === 'resolve') {
    const sessionId = requiredSession(flags, runtime);
    const errorId = flags.error || positional[1];
    const state = await readState(dataDir, sessionId);
    if (!state) throw Object.assign(new Error('Thread cache does not exist.'), { code: 'STATE_NOT_FOUND' });
    const consumeAuthorization = requireCommandAuthorization(state, 'status_resolve');
    await resolveError(dataDir, errorId, flags.resolution || `Resolved from session ${sessionId}`);
    consumeAuthorization();
    await writeState(dataDir, state);
    return { resolved: errorId };
  }
  const all = Boolean(flags.all);
  const sessionId = all ? undefined : requiredSession(flags, runtime);
  const errors = await unresolvedErrors(dataDir, { sessionId, all, limit: Number(flags.limit || 20) });
  const state = sessionId ? await readState(dataDir, sessionId) : null;
  let metadata = null;
  let config = null;
  try {
    config = await pluginConfig(dataDir, runtime);
    metadata = await readProjectMetadata(dataDir, config);
  } catch {}
  const policy = metadata?.creationPolicy;
  const issueRepository = policy?.repository || (config ? creationRepository(config) : '');
  const creationPolicyLine = policy
    ? `Creation route: Project ${policy.projectVisibility}, Issue repository ${issueRepository || 'not configured'} (${policy.repositoryVisibility || 'n/a'}) -> ${policy.route}.`
    : 'Creation route: unknown; run check to inspect Project and Issue repository visibility.';
  const kanbanStatusLine = metadata?.availableStatuses?.length
    ? `Kanban statuses: ${metadata.availableStatuses.join(', ')}.`
    : 'Kanban statuses: unknown; run check to refresh them.';
  const kanbanPolicyLine = config?.kanban?.defaultStatus
    ? `Kanban policy: default ${config.kanban.defaultStatus}; terminal ${config.kanban.terminalStatuses.length ? config.kanban.terminalStatuses.join(', ') : 'none'}.`
    : 'Kanban policy: default status unknown; rerun init.';
  const pendingPlanLine = state?.pendingPlan
    ? `Pending submission: ${state.pendingPlan.plan.updates.length} item update(s), ${state.pendingPlan.operations.length} write operation(s), ${state.pendingPlan.submissionStatus}.`
    : 'Pending submission: none.';
  return { scope: all ? 'all sessions' : sessionId, creationPolicyLine, kanbanStatusLine, kanbanPolicyLine, pendingPlanLine, unresolvedCount: errors.length, errors };
}

async function recordErrorCommand(dataDir, flags, runtime) {
  const sessionId = requiredSession(flags, runtime);
  const event = await logError(dataDir, {
    sessionId,
    updateRunId: flags.run || null,
    stage: flags.stage || 'agent',
    errorCode: flags.code || 'AGENT_FAILURE',
    message: flags.message || 'Agent workflow failed.'
  });
  return { recorded: event.errorId };
}

export async function executeBackend({ command, positional = [], options = {} }, runtime) {
  requireRuntime(runtime);
  const flags = options;
  const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : runtime.dataDir;
  if (command === 'init') return initCommand(dataDir, flags, positional, runtime);
  if (command === 'settings') {
    const config = await pluginConfig(dataDir, runtime);
    return { models: config.models, update: config.update };
  }
  if (command === 'create') return createCommand(dataDir, flags, positional, runtime);
  if (command === 'bind') return bindCommand(dataDir, flags, positional, runtime);
  if (command === 'unbind') return unbindCommand(dataDir, flags, positional, runtime);
  if (command === 'check') return checkCommand(dataDir, flags, runtime);
  if (command === 'update') return updateCommand(dataDir, flags, positional, runtime);
  if (command === 'status') return statusCommand(dataDir, flags, positional, runtime);
  if (command === 'record-error') return recordErrorCommand(dataDir, flags, runtime);
  throw Object.assign(new Error('Use init, create, bind, unbind, update, check, or status.'), { code: 'COMMAND_INVALID' });
}

export async function runBackend(argv, runtime) {
  const command = argv[0];
  const { positional, flags } = parseCommandArgs(argv.slice(1));
  return executeBackend({ command, positional, options: flags }, runtime);
}
