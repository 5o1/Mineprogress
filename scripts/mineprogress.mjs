#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { configPath, createConfig, loadConfig, saveConfig } from './lib/config.mjs';
import { suggestBindings } from './lib/check.mjs';
import {
  applyUpdatePlan,
  createTextField,
  createKanbanItem,
  inspectCreationPolicy,
  makeClient,
  projectStatusOptions,
  readProject
} from './lib/github-projects.mjs';
import { classifyError, logError, resolveError, unresolvedErrors } from './lib/errors.mjs';
import { readProjectMetadata, updateProjectMetadata } from './lib/metadata.mjs';
import {
  beginUpdate,
  bindItem,
  completeUpdate,
  openSession,
  pendingJournal,
  readState,
  requireDataDir,
  retryExhaustedUpdate,
  unbindItem,
  writeState
} from './lib/state.mjs';
import { validatePlan, validateReview } from './lib/validation.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function pluginConfig(dataDir) {
  return loadConfig(configPath(process.env, ROOT, dataDir));
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (['all', 'json', 'confirm'].includes(key)) flags[key] = true;
    else flags[key] = argv[++index];
  }
  return { positional, flags };
}

function requiredSession(flags) {
  const sessionId = flags.session || process.env.MINEPROGRESS_SESSION_ID;
  if (!sessionId) throw Object.assign(new Error('Pass --session <session_id>.'), { code: 'SESSION_ID_REQUIRED' });
  return sessionId;
}

async function readJson(file) {
  if (!file) throw Object.assign(new Error('A JSON file path is required.'), { code: 'INPUT_FILE_REQUIRED' });
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function githubClient() {
  return makeClient(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
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
  return createConfig({
    ...parseProjectUrl(flags['project-url']),
    defaultRepository: flags.repository || '',
    statusFieldName: flags['status-field'] || 'Status',
    updateFieldName: flags['update-field'] || 'Update'
  });
}

async function inspectInitialization(dataDir, flags) {
  const config = initializationConfig(flags);
  const client = githubClient();
  const project = await readProject(config, client);
  const fields = project.fields?.nodes || [];
  const statusField = fields.find(field => field.name === config.statusFieldName);
  const updateField = fields.find(field => field.name === config.updateFieldName);
  const availableStatuses = (statusField?.options || []).map(option => option.name);
  const creationPolicy = await inspectCreationPolicy(config, client, project);
  return {
    config,
    project,
    availableStatuses,
    creationPolicy,
    statusFieldFound: Boolean(statusField),
    updateFieldFound: Boolean(updateField),
    configTarget: configPath(process.env, ROOT, dataDir)
  };
}

async function initCommand(dataDir, flags, positional) {
  const action = positional[0] || 'preview';
  const inspection = await inspectInitialization(dataDir, flags);
  const preview = {
    project: inspection.project.title,
    owner: inspection.config.owner,
    ownerType: inspection.config.ownerType,
    projectNumber: inspection.config.projectNumber,
    defaultRepository: inspection.config.defaultRepository || null,
    projectVisibility: inspection.creationPolicy.projectVisibility,
    repositoryVisibility: inspection.creationPolicy.repositoryVisibility,
    creationRoute: inspection.creationPolicy.route,
    availableStatuses: inspection.availableStatuses,
    statusFieldFound: inspection.statusFieldFound,
    updateFieldFound: inspection.updateFieldFound,
    willCreateFields: inspection.updateFieldFound ? [] : [inspection.config.updateFieldName],
    configTarget: inspection.configTarget
  };
  if (action === 'preview') return { outcome: 'confirmation_required', ...preview };
  if (action !== 'apply') throw Object.assign(new Error(`Unknown init action: ${action}`), { code: 'INIT_ACTION_INVALID' });
  if (!flags.confirm) throw Object.assign(new Error('init apply requires --confirm after user confirmation.'), { code: 'INIT_CONFIRMATION_REQUIRED' });
  if (!inspection.statusFieldFound || !inspection.availableStatuses.length) {
    throw Object.assign(new Error(`Project must contain a populated ${inspection.config.statusFieldName} single-select field.`), { code: 'PROJECT_STATUS_FIELD_REQUIRED' });
  }
  if (!inspection.updateFieldFound) {
    await createTextField(githubClient(), inspection.project.id, inspection.config.updateFieldName);
  }
  await saveConfig(inspection.configTarget, inspection.config);
  await updateProjectMetadata(dataDir, inspection.config, {
    availableStatuses: inspection.availableStatuses,
    creationPolicy: {
      projectVisibility: inspection.creationPolicy.projectVisibility,
      repositoryVisibility: inspection.creationPolicy.repositoryVisibility,
      route: inspection.creationPolicy.route,
      key: inspection.creationPolicy.key
    }
  });
  return { outcome: 'initialized', ...preview, updateFieldCreated: !inspection.updateFieldFound };
}

async function createCommand(dataDir, flags, positional) {
  const sessionId = requiredSession(flags);
  const title = flags.title || positional.join(' ');
  const config = await pluginConfig(dataDir);
  const item = await createKanbanItem(config, githubClient(), title);
  await updateProjectMetadata(dataDir, config, { creationPolicy: {
    projectVisibility: item.policy.projectVisibility,
    repositoryVisibility: item.policy.repositoryVisibility,
    route: item.policy.route,
    key: item.policy.key
  } });
  const { state } = await openSession(dataDir, sessionId);
  bindItem(state, item);
  await writeState(dataDir, state);
  return {
    created: {
      itemId: item.itemId,
      title: item.title,
      kind: item.kind,
      issueNumber: item.issueNumber || null,
      issueUrl: item.issueUrl || null,
      route: item.policy.route,
      projectVisibility: item.policy.projectVisibility,
      repositoryVisibility: item.policy.repositoryVisibility
    },
    bound: true
  };
}

async function bindCommand(dataDir, flags, positional) {
  const sessionId = requiredSession(flags);
  const itemId = flags.item || positional[0];
  if (!itemId) throw Object.assign(new Error('Pass --item <Project item id>.'), { code: 'ITEM_ID_REQUIRED' });
  const config = await pluginConfig(dataDir);
  const project = await readProject(config, githubClient());
  const item = project.normalizedItems.find(candidate => candidate.itemId === itemId);
  if (!item) throw Object.assign(new Error('Item is not in the configured Project.'), { code: 'PROJECT_ITEM_NOT_FOUND' });
  const { state } = await openSession(dataDir, sessionId);
  const changed = bindItem(state, item);
  await writeState(dataDir, state);
  return { changed, item };
}

async function unbindCommand(dataDir, flags, positional) {
  const sessionId = requiredSession(flags);
  const itemId = flags.item || positional[0];
  if (!itemId) throw Object.assign(new Error('Pass --item <Project item id>.'), { code: 'ITEM_ID_REQUIRED' });
  const { state } = await openSession(dataDir, sessionId);
  const changed = unbindItem(state, itemId);
  await writeState(dataDir, state);
  return { changed, itemId };
}

async function checkCommand(dataDir, flags) {
  const sessionId = requiredSession(flags);
  const state = await readState(dataDir, sessionId);
  if (!state) throw Object.assign(new Error('Thread cache does not exist.'), { code: 'STATE_NOT_FOUND' });
  const config = await pluginConfig(dataDir);
  const project = await readProject(config, githubClient());
  const availableStatuses = projectStatusOptions(project, config).map(option => option.name);
  const creationPolicy = await inspectCreationPolicy(config, githubClient(), project);
  await updateProjectMetadata(dataDir, config, {
    availableStatuses,
    creationPolicy: {
      projectVisibility: creationPolicy.projectVisibility,
      repositoryVisibility: creationPolicy.repositoryVisibility,
      route: creationPolicy.route,
      key: creationPolicy.key
    }
  });
  return {
    availableStatuses,
    creationPolicy: {
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

async function prepareUpdate(dataDir, sessionId) {
  const { state } = await openSession(dataDir, sessionId);
  const run = beginUpdate(state);
  if (!run) return { outcome: 'noop', reason: 'No context exists after the last successful update.' };
  if (run.exhausted) {
    return { outcome: 'exhausted', runId: run.runId, errorId: run.exhaustionErrorId, reason: 'Content attempts are suspended. Use update retry only after the user explicitly requests another run.' };
  }
  if (run.approvedReview?.decision === 'approve' && run.stagedPlan) {
    return { outcome: 'resume_apply', sessionId, runId: run.runId, reason: 'Resume the approved idempotent transaction with update apply; no new review is required.' };
  }
  if (!state.boundItems.length) {
    completeUpdate(state, run.runId);
    await writeState(dataDir, state);
    return { outcome: 'noop', reason: 'No items are bound; checkpoint advanced.' };
  }
  const config = await pluginConfig(dataDir);
  const project = await readProject(config, githubClient());
  const availableStatuses = projectStatusOptions(project, config).map(option => option.name);
  await updateProjectMetadata(dataDir, config, { availableStatuses });
  const boundIds = new Set(state.boundItems.map(item => item.itemId));
  const prompt = await fs.readFile(path.join(ROOT, 'prompts', 'update.md'), 'utf8');
  await writeState(dataDir, state);
  return {
    outcome: 'generate_and_review',
    sessionId,
    runId: run.runId,
    attempt: run.attempt + 1,
    maxAttempts: config.update.maxReviewAttempts,
    model: config.models.update,
    reviewModel: config.models.review,
    preferFastMode: config.models.preferFastMode,
    prompt,
    availableStatuses,
    allowedOutput: { updates: [{ itemId: 'bound-id', status: 'exact available status name', summary: 'concise redacted update' }] },
    boundItems: project.normalizedItems.filter(item => boundIds.has(item.itemId)),
    context: pendingJournal(state).filter(event => event.sequence <= run.toSequence)
  };
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

async function stageUpdate(dataDir, sessionId, flags) {
  const state = await readState(dataDir, sessionId);
  if (!state?.activeUpdate) throw Object.assign(new Error('No update run is active.'), { code: 'UPDATE_NOT_ACTIVE' });
  const config = await pluginConfig(dataDir);
  if (state.activeUpdate.approvedReview) {
    throw Object.assign(new Error('The staged plan is already approved; resume update apply.'), { code: 'UPDATE_ALREADY_APPROVED' });
  }
  if (state.activeUpdate.attempt >= config.update.maxReviewAttempts) {
    return { accepted: false, exhausted: true, attempt: state.activeUpdate.attempt, errors: ['Maximum content attempts already reached.'] };
  }
  const plan = await readJson(flags.plan);
  const metadata = await readProjectMetadata(dataDir, config);
  if (!metadata?.availableStatuses?.length) {
    throw Object.assign(new Error('Kanban statuses are not cached; run check or update prepare first.'), { code: 'KANBAN_STATUS_UNKNOWN' });
  }
  state.activeUpdate.attempt++;
  const report = validatePlan(plan, {
    boundItemIds: state.boundItems.map(item => item.itemId),
    allowedStatuses: metadata.availableStatuses,
    maxCharacters: config.update.maxSummaryCharacters,
    maxWords: config.update.maxSummaryWords
  });
  if (!report.valid) {
    state.activeUpdate.stagedPlan = null;
    const exhausted = await exhaustIfNeeded(dataDir, state, config, 'static-validation', report.errors.join(' '));
    await writeState(dataDir, state);
    return { accepted: false, exhausted, attempt: state.activeUpdate.attempt, errors: report.errors };
  }
  state.activeUpdate.stagedPlan = plan;
  state.activeUpdate.staticReport = report;
  await writeState(dataDir, state);
  return {
    accepted: true,
    attempt: state.activeUpdate.attempt,
    reviewModel: config.models.review,
    reviewPromptPath: path.join(ROOT, 'prompts', 'review.md'),
    staticReport: report,
    plan
  };
}

async function applyUpdate(dataDir, sessionId, flags) {
  const state = await readState(dataDir, sessionId);
  if (!state?.activeUpdate?.stagedPlan) throw Object.assign(new Error('No statically valid plan is staged.'), { code: 'PLAN_NOT_STAGED' });
  const config = await pluginConfig(dataDir);
  const review = state.activeUpdate.approvedReview || await readJson(flags.review);
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
  if (!state.activeUpdate.stagedPlan.updates.length) {
    completeUpdate(state, runId);
    await writeState(dataDir, state);
    return { applied: true, fieldUpdates: 0, checkpointAdvanced: true };
  }
  const result = await applyUpdatePlan(config, githubClient(), state.activeUpdate.stagedPlan, {
    alreadyApplied: state.activeUpdate.appliedOperations,
    onApplied: async key => {
      state.activeUpdate.appliedOperations.push(key);
      await writeState(dataDir, state);
    }
  });
  completeUpdate(state, runId);
  await writeState(dataDir, state);
  return { applied: true, fieldUpdates: result.applied, checkpointAdvanced: true };
}

async function updateCommand(dataDir, flags, positional) {
  const sessionId = requiredSession(flags);
  const action = positional[0] || 'prepare';
  if (action === 'prepare') return prepareUpdate(dataDir, sessionId);
  if (action === 'retry') {
    const state = await readState(dataDir, sessionId);
    if (!state) throw Object.assign(new Error('Thread cache does not exist.'), { code: 'STATE_NOT_FOUND' });
    retryExhaustedUpdate(state);
    await writeState(dataDir, state);
    return prepareUpdate(dataDir, sessionId);
  }
  if (action === 'stage') return stageUpdate(dataDir, sessionId, flags);
  if (action === 'apply') return applyUpdate(dataDir, sessionId, flags);
  throw Object.assign(new Error(`Unknown update action: ${action}`), { code: 'UPDATE_ACTION_INVALID' });
}

async function statusCommand(dataDir, flags, positional) {
  if (positional[0] === 'resolve') {
    const sessionId = requiredSession(flags);
    const errorId = flags.error || positional[1];
    await resolveError(dataDir, errorId, flags.resolution || `Resolved from session ${sessionId}`);
    return { resolved: errorId };
  }
  const all = Boolean(flags.all);
  const sessionId = all ? undefined : requiredSession(flags);
  const errors = await unresolvedErrors(dataDir, { sessionId, all, limit: Number(flags.limit || 20) });
  let metadata = null;
  try { metadata = await readProjectMetadata(dataDir, await pluginConfig(dataDir)); } catch {}
  const policy = metadata?.creationPolicy;
  const creationPolicyLine = policy
    ? `Creation route: Project ${policy.projectVisibility}, repository ${policy.repositoryVisibility || 'not configured'} -> ${policy.route}.`
    : 'Creation route: unknown; run check to inspect Project and repository visibility.';
  const kanbanStatusLine = metadata?.availableStatuses?.length
    ? `Kanban statuses: ${metadata.availableStatuses.join(', ')}.`
    : 'Kanban statuses: unknown; run check to refresh them.';
  return { scope: all ? 'all sessions' : sessionId, creationPolicyLine, kanbanStatusLine, unresolvedCount: errors.length, errors };
}

async function recordErrorCommand(dataDir, flags) {
  const sessionId = requiredSession(flags);
  const event = await logError(dataDir, {
    sessionId,
    updateRunId: flags.run || null,
    stage: flags.stage || 'agent',
    errorCode: flags.code || 'AGENT_FAILURE',
    message: flags.message || 'Agent workflow failed.'
  });
  return { recorded: event.errorId };
}

export async function run(argv = process.argv.slice(2)) {
  const command = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : requireDataDir();
  if (command === 'init') return initCommand(dataDir, flags, positional);
  if (command === 'settings') {
    const config = await pluginConfig(dataDir);
    return { models: config.models, update: config.update };
  }
  if (command === 'create') return createCommand(dataDir, flags, positional);
  if (command === 'bind') return bindCommand(dataDir, flags, positional);
  if (command === 'unbind') return unbindCommand(dataDir, flags, positional);
  if (command === 'check') return checkCommand(dataDir, flags);
  if (command === 'update') return updateCommand(dataDir, flags, positional);
  if (command === 'status') return statusCommand(dataDir, flags, positional);
  if (command === 'record-error') return recordErrorCommand(dataDir, flags);
  throw Object.assign(new Error('Use init, create, bind, unbind, update, check, or status.'), { code: 'COMMAND_INVALID' });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) {
  run().then(result => console.log(JSON.stringify(result, null, 2))).catch(async error => {
    const classification = classifyError(error);
    if (classification.sandboxDenied && !process.env.MINEPROGRESS_ELEVATED_RETRY) {
      console.error(JSON.stringify({ errorCode: error.code, requestElevation: true, message: 'Retry this exact command once with sandbox elevation.' }));
      process.exitCode = 77;
      return;
    }
    try {
      const cli = parseArgs(process.argv.slice(3));
      const logDataDir = cli.flags['data-dir'] ? path.resolve(cli.flags['data-dir']) : requireDataDir();
      const sessionId = cli.flags.session || process.env.MINEPROGRESS_SESSION_ID || null;
      const state = sessionId ? await readState(logDataDir, sessionId).catch(() => null) : null;
      await logError(logDataDir, {
        sessionId,
        updateRunId: state?.activeUpdate?.runId || null,
        stage: 'command',
        errorCode: classification.code,
        message: error.message
      });
    } catch {}
    console.error(JSON.stringify({ errorCode: classification.code, message: error.message }));
    process.exitCode = 1;
  });
}
