import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';
import { calendarDate } from './calendar.mjs';
import { normalizeContentLanguage } from './language.mjs';
import { normalizePrimaryRepository } from './repository-reference.mjs';

const STATE_VERSION = 1;
const PLAN_FORMAT_VERSION = 4;

export function statePath(dataDir, sessionId) {
  if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'SESSION_ID_REQUIRED' });
  const key = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(dataDir, 'threads', `${key}.json`);
}

export function newState(sessionId, now = new Date().toISOString()) {
  return {
    version: STATE_VERSION,
    planFormatVersion: PLAN_FORMAT_VERSION,
    sessionId,
    createdAt: now,
    updatedAt: now,
    lastEndedAt: null,
    dailySubmissionDate: calendarDate(now),
    boundItems: [],
    journal: [],
    controlTurnIds: [],
    pendingAuthorizations: [],
    nextSequence: 1,
    lastPlannedUpdate: null,
    lastSuccessfulUpdate: null,
    pendingPlan: null,
    activeUpdate: null,
    backgroundRequestedThrough: null,
    fullContextRequestedRevision: 0,
    fullContextPlannedRevision: 0
  };
}

function normalizeState(state) {
  const previousPlanFormat = state.planFormatVersion || 1;
  for (const item of state.boundItems || []) {
    item.bindingSource ||= 'bind';
    item.backfillRevision ??= 1;
    item.contentId ??= null;
    item.contentType ??= null;
    item.url ??= null;
    item.repository ??= null;
    item.proposalInitialized ??= item.bindingSource !== 'create';
    item.contentLanguage = normalizeContentLanguage(item.contentLanguage);
    item.primaryRepository = normalizePrimaryRepository(item.primaryRepository, item.title);
  }
  state.lastPlannedUpdate ??= state.lastSuccessfulUpdate || null;
  state.dailySubmissionDate ??= calendarDate(state.updatedAt || state.createdAt);
  state.pendingPlan ??= null;
  state.backgroundRequestedThrough ??= null;
  if (state.fullContextRequestedRevision === undefined) {
    state.fullContextRequestedRevision = state.boundItems.length ? 1 : 0;
  }
  state.fullContextPlannedRevision ??= 0;
  if (previousPlanFormat < PLAN_FORMAT_VERSION) {
    if (!state.pendingPlan?.attempts?.length) state.pendingPlan = null;
    state.activeUpdate = null;
    if (state.boundItems.length) {
      const revision = (state.fullContextRequestedRevision || 0) + 1;
      for (const item of state.boundItems) item.backfillRevision = revision;
      state.fullContextRequestedRevision = revision;
    }
    state.planFormatVersion = PLAN_FORMAT_VERSION;
  }
  if (state.activeUpdate && state.fullContextRequestedRevision > state.fullContextPlannedRevision &&
      state.activeUpdate.fullContextRevision === undefined) {
    state.activeUpdate.useThreadHistory = true;
    state.activeUpdate.fullContextRevision = state.fullContextRequestedRevision;
  }
  return state;
}

export async function readState(dataDir, sessionId) {
  const file = statePath(dataDir, sessionId);
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (state.version !== STATE_VERSION || state.sessionId !== sessionId) {
      throw Object.assign(new Error('Thread state is incompatible or belongs to another session'), { code: 'STATE_INVALID' });
    }
    return normalizeState(state);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeState(dataDir, state) {
  const file = statePath(dataDir, state.sessionId);
  state.updatedAt = new Date().toISOString();
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export async function openSession(dataDir, sessionId) {
  const existing = await readState(dataDir, sessionId);
  if (existing) return { state: existing, restored: true };
  const state = newState(sessionId);
  await writeState(dataDir, state);
  return { state, restored: false };
}

export function authorizeCommand(state, action, turnId) {
  if (!['create', 'bind', 'unbind', 'update_retry', 'status_resolve'].includes(action)) return false;
  state.pendingAuthorizations ||= [];
  if (state.pendingAuthorizations.some(entry => entry.action === action && entry.turnId === (turnId || null))) return true;
  state.pendingAuthorizations.push({ action, turnId: turnId || null, createdAt: new Date().toISOString() });
  state.pendingAuthorizations = state.pendingAuthorizations.slice(-20);
  return true;
}

export function requireCommandAuthorization(state, action, now = Date.now()) {
  state.pendingAuthorizations ||= [];
  const index = state.pendingAuthorizations.findIndex(entry =>
    entry.action === action && now - Date.parse(entry.createdAt) <= 10 * 60 * 1000);
  if (index < 0) {
    throw Object.assign(new Error(`${action} requires an explicit current Mineprogress user command.`), { code: 'USER_AUTHORIZATION_REQUIRED' });
  }
  return () => state.pendingAuthorizations.splice(index, 1);
}

export function appendJournal(state, { kind, turnId, text, control = false }) {
  const normalized = String(text || '').trim();
  if (!normalized || control) return null;
  const event = {
    sequence: state.nextSequence++,
    kind,
    turnId: turnId || null,
    text: normalized,
    timestamp: new Date().toISOString()
  };
  state.journal.push(event);
  return event;
}

export function markControlTurn(state, turnId) {
  state.controlTurnIds ||= [];
  if (turnId && !state.controlTurnIds.includes(turnId)) state.controlTurnIds.push(turnId);
  state.controlTurnIds = state.controlTurnIds.slice(-50);
}

export function isControlTurn(state, turnId) {
  return Boolean(turnId && state.controlTurnIds?.includes(turnId));
}

export function bindItem(state, item, {
  source = 'bind',
  contentLanguage = 'en',
  primaryRepository = null
} = {}) {
  const normalizedLanguage = normalizeContentLanguage(contentLanguage);
  const normalizedRepository = normalizePrimaryRepository(primaryRepository, item.title);
  const existing = state.boundItems.find(bound => bound.itemId === item.itemId);
  if (existing) {
    let changed = false;
    if (existing.contentLanguage !== normalizedLanguage) {
      existing.contentLanguage = normalizedLanguage;
      changed = true;
    }
    if (normalizedRepository && JSON.stringify(existing.primaryRepository) !== JSON.stringify(normalizedRepository)) {
      existing.primaryRepository = normalizedRepository;
      changed = true;
    }
    return changed;
  }
  const backfillRevision = (state.fullContextRequestedRevision || 0) + 1;
  state.boundItems.push({
    itemId: item.itemId,
    title: item.title || null,
    contentId: item.contentId || null,
    contentType: item.contentType || item.kind || null,
    url: item.url || item.issueUrl || null,
    repository: item.repository || null,
    proposalInitialized: source !== 'create',
    contentLanguage: normalizedLanguage,
    primaryRepository: normalizedRepository,
    bindingSource: source,
    backfillRevision,
    boundAt: new Date().toISOString()
  });
  state.fullContextRequestedRevision = backfillRevision;
  state.fullContextPlannedRevision ??= 0;
  return true;
}

export function unbindItem(state, itemId) {
  const before = state.boundItems.length;
  state.boundItems = state.boundItems.filter(item => item.itemId !== itemId);
  if (state.pendingPlan?.plan?.updates) {
    state.pendingPlan.plan.updates = state.pendingPlan.plan.updates.filter(update => update.itemId !== itemId);
    state.pendingPlan.operations = (state.pendingPlan.operations || []).filter(operation => operation.itemId !== itemId);
    if (!state.pendingPlan.plan.updates.length) state.pendingPlan = null;
  }
  return state.boundItems.length !== before;
}

export function pendingJournal(state) {
  const after = state.lastPlannedUpdate?.sequence || state.lastSuccessfulUpdate?.sequence || 0;
  return state.journal.filter(event => event.sequence > after);
}

export function needsFullContext(state) {
  return (state.fullContextRequestedRevision || 0) > (state.fullContextPlannedRevision || 0);
}

export function hasPendingPlanning(state) {
  return needsFullContext(state) || pendingJournal(state).length > 0;
}

export function beginUpdate(state, runId = crypto.randomUUID()) {
  if (state.activeUpdate) return state.activeUpdate;
  const events = pendingJournal(state);
  const useThreadHistory = needsFullContext(state);
  if (!events.length && !useThreadHistory) return null;
  const checkpoint = state.lastPlannedUpdate?.sequence || state.lastSuccessfulUpdate?.sequence || 0;
  const toSequence = events.at(-1)?.sequence || checkpoint;
  state.activeUpdate = {
    runId,
    fromSequence: checkpoint,
    toSequence,
    useThreadHistory,
    fullContextRevision: useThreadHistory ? state.fullContextRequestedRevision : null,
    attempt: 0,
    stagedPlan: null,
    appliedOperations: [],
    startedAt: new Date().toISOString()
  };
  return state.activeUpdate;
}

export function retryExhaustedUpdate(state) {
  if (!state.activeUpdate?.exhausted) {
    throw Object.assign(new Error('The active update is not exhausted.'), { code: 'UPDATE_NOT_EXHAUSTED' });
  }
  state.activeUpdate = null;
  return beginUpdate(state);
}

export async function pruneStaleStates(dataDir, { retentionDays = 30, keepSessionId, now = Date.now() } = {}) {
  const directory = path.join(path.resolve(dataDir), 'threads');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.resolve(directory, entry.name);
    if (path.dirname(file) !== path.resolve(directory)) continue;
    let state;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    if (state.sessionId === keepSessionId || !state.lastEndedAt) continue;
    if (Date.parse(state.lastEndedAt) < cutoff) {
      await fs.unlink(file);
      removed++;
    }
  }
  return removed;
}

export function completeUpdate(state, runId) {
  if (!state.activeUpdate || state.activeUpdate.runId !== runId) {
    throw Object.assign(new Error('The update run is not active'), { code: 'UPDATE_RUN_MISMATCH' });
  }
  const sequence = state.activeUpdate.toSequence;
  if (state.activeUpdate.fullContextRevision) {
    state.fullContextPlannedRevision = Math.max(
      state.fullContextPlannedRevision || 0,
      state.activeUpdate.fullContextRevision
    );
  }
  state.lastPlannedUpdate = { sequence, runId, completedAt: new Date().toISOString() };
  state.journal = state.journal.filter(event => event.sequence > sequence);
  state.activeUpdate = null;
}

export function storePendingPlan(state, runId, plan, submission, review) {
  if (!state.activeUpdate || state.activeUpdate.runId !== runId) {
    throw Object.assign(new Error('The update run is not active'), { code: 'UPDATE_RUN_MISMATCH' });
  }
  const sequence = state.activeUpdate.toSequence;
  state.pendingPlan = submission.operations.length ? {
    plan,
    projectId: submission.projectId,
    operations: submission.operations,
    throughSequence: sequence,
    approvedAt: new Date().toISOString(),
    submissionStatus: 'ready',
    attempts: [],
    review
  } : null;
  completeUpdate(state, runId);
  return state.pendingPlan;
}

export function beginSubmissionAttempt(state, operationKeys) {
  if (!state.pendingPlan) throw Object.assign(new Error('No reviewed plan is pending.'), { code: 'PLAN_NOT_PENDING' });
  const attempt = {
    attemptId: crypto.randomUUID(),
    operationKeys: [...operationKeys],
    startedAt: new Date().toISOString(),
    responseReceivedAt: null
  };
  state.pendingPlan.submissionStatus = 'unverified';
  state.pendingPlan.attempts ||= [];
  state.pendingPlan.attempts.push(attempt);
  return attempt;
}

export function confirmSubmissionResponse(state, attemptId) {
  const attempt = state.pendingPlan?.attempts?.find(candidate => candidate.attemptId === attemptId);
  if (!attempt) throw Object.assign(new Error('Submission attempt was not found.'), { code: 'SUBMISSION_ATTEMPT_NOT_FOUND' });
  attempt.responseReceivedAt = new Date().toISOString();
  return attempt;
}

export function completeSubmission(state) {
  if (!state.pendingPlan) return false;
  const proposalItemIds = new Set((state.pendingPlan.operations || [])
    .filter(operation => operation.kind === 'proposalBody')
    .map(operation => operation.itemId));
  for (const binding of state.boundItems) {
    if (proposalItemIds.has(binding.itemId)) binding.proposalInitialized = true;
  }
  state.lastSuccessfulUpdate = {
    sequence: state.pendingPlan.throughSequence,
    completedAt: new Date().toISOString()
  };
  state.pendingPlan = null;
  return true;
}
