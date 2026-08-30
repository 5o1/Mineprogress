import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const STATE_VERSION = 1;

export function requireDataDir(env = process.env) {
  const dataDir = env.PLUGIN_DATA || env.MINEPROGRESS_DATA;
  if (!dataDir) {
    throw Object.assign(new Error('PLUGIN_DATA is required (MINEPROGRESS_DATA is accepted for local testing)'), { code: 'PLUGIN_DATA_UNAVAILABLE' });
  }
  return path.resolve(dataDir);
}

export function statePath(dataDir, sessionId) {
  if (!sessionId) throw Object.assign(new Error('session_id is required'), { code: 'SESSION_ID_REQUIRED' });
  const key = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(dataDir, 'threads', `${key}.json`);
}

export function newState(sessionId, now = new Date().toISOString()) {
  return {
    version: STATE_VERSION,
    sessionId,
    createdAt: now,
    updatedAt: now,
    lastEndedAt: null,
    boundItems: [],
    journal: [],
    controlTurnIds: [],
    pendingAuthorizations: [],
    nextSequence: 1,
    lastPlannedUpdate: null,
    lastSuccessfulUpdate: null,
    pendingPlan: null,
    activeUpdate: null
  };
}

function normalizeState(state) {
  state.lastPlannedUpdate ??= state.lastSuccessfulUpdate || null;
  state.pendingPlan ??= null;
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
  return state;
}

export async function openSession(dataDir, sessionId) {
  const existing = await readState(dataDir, sessionId);
  if (existing) return { state: existing, restored: true };
  const state = newState(sessionId);
  await writeState(dataDir, state);
  return { state, restored: false };
}

export function isControlPrompt(text = '') {
  const prompt = String(text);
  if (/^\s*\$mineprogress(?::|\b)/i.test(prompt)) {
    return /^\s*\$mineprogress:(?:init|create|bind|unbind|update|check|status)\b/i.test(prompt);
  }
  return /\bmineprogress\b/i.test(prompt)
    && /(?:init(?:ialize)?|setup|create|bind|unbind|update|check|status|\u521d\u59cb\u5316|\u521b\u5efa|\u7ed1\u5b9a|\u89e3\u7ed1|\u66f4\u65b0|\u68c0\u67e5|\u72b6\u6001)/i.test(prompt);
}

export function controlCommandAction(text = '') {
  const normalized = String(text).toLowerCase();
  const explicit = normalized.match(/^\s*\$mineprogress:(init|create|bind|unbind|update|check|status)\b/);
  if (!explicit && /^\s*\$mineprogress(?::|\b)/.test(normalized)) return null;
  const command = explicit?.[1] || (/\bmineprogress\b/.test(normalized)
    ? [['init', /init(?:ialize)?|setup|\u521d\u59cb\u5316/], ['create', /create|\u521b\u5efa/], ['unbind', /unbind|\u89e3\u7ed1/], ['bind', /bind|\u7ed1\u5b9a/], ['update', /update|\u66f4\u65b0/], ['check', /check|\u68c0\u67e5/], ['status', /status|\u72b6\u6001/]]
      .find(([, pattern]) => pattern.test(normalized))?.[0]
    : null);
  if (command === 'update' && /\bretry\b|\u91cd\u8bd5/.test(normalized)) return 'update_retry';
  if (command === 'status' && /\bresolve\b|\u5904\u7406|\u89e3\u51b3/.test(normalized)) return 'status_resolve';
  return command;
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

export function bindItem(state, item) {
  if (state.boundItems.some(bound => bound.itemId === item.itemId)) return false;
  state.boundItems.push({ itemId: item.itemId, title: item.title || null, boundAt: new Date().toISOString() });
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

export function beginUpdate(state, runId = crypto.randomUUID()) {
  if (state.activeUpdate) return state.activeUpdate;
  const events = pendingJournal(state);
  if (!events.length) return null;
  const toSequence = events.at(-1).sequence;
  state.activeUpdate = {
    runId,
    fromSequence: state.lastPlannedUpdate?.sequence || state.lastSuccessfulUpdate?.sequence || 0,
    toSequence,
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
  state.lastSuccessfulUpdate = {
    sequence: state.pendingPlan.throughSequence,
    completedAt: new Date().toISOString()
  };
  state.pendingPlan = null;
  return true;
}
