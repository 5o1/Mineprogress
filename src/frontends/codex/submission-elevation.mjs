import crypto from 'node:crypto';
import { logError, resolveError, unresolvedErrors } from '../../backend/errors.mjs';
import { withSessionLock } from '../../backend/lock.mjs';
import { readState, writeState } from '../../backend/state.mjs';

const ELEVATION_CODES = new Set(['SANDBOX_DENIED', 'GH_NETWORK_ERROR']);
const RETRYABLE_STATES = new Set(['required', 'in_progress']);
const ELEVATION_ACTIONS = new Set(['prepare', 'submit']);

function elevationLocation(state) {
  if (state?.pendingPlan?.submissionBlock?.kind === 'sandbox-elevation') {
    return { scope: 'submission', block: state.pendingPlan.submissionBlock };
  }
  if (state?.workflowBlock?.kind === 'sandbox-elevation') {
    return { scope: 'workflow', block: state.workflowBlock };
  }
  return null;
}

function defaultAction(state) {
  return state?.pendingPlan ? 'submit' : 'prepare';
}

function locationAction(location) {
  return location?.block.action || (location?.scope === 'submission' ? 'submit' : 'prepare');
}

function setElevation(state, scope, elevation) {
  if (scope === 'submission') state.pendingPlan.submissionBlock = elevation;
  else state.workflowBlock = elevation;
}

export function isSubmissionElevationCandidate(error) {
  return ELEVATION_CODES.has(error?.code);
}

export function pendingSubmissionElevation(state) {
  const block = state?.pendingPlan?.submissionBlock;
  return block?.kind === 'sandbox-elevation' && RETRYABLE_STATES.has(block.status) ? block : null;
}

export function pendingElevation(state) {
  const location = elevationLocation(state);
  return location && RETRYABLE_STATES.has(location.block.status)
    ? { ...location.block, action: locationAction(location) }
    : null;
}

export function submissionBlockedByElevation(state) {
  return state?.pendingPlan?.submissionBlock?.kind === 'sandbox-elevation';
}

export function workflowBlockedByElevation(state) {
  return elevationLocation(state)?.block || null;
}

export async function requestSubmissionElevation(dataDir, sessionId, error, { action = null } = {}) {
  if (!isSubmissionElevationCandidate(error)) return null;
  const result = await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    if (!state || (!state.pendingPlan && !state.boundItems?.length && !state.activeUpdate)) return null;
    const requestedAction = ELEVATION_ACTIONS.has(action) ? action : defaultAction(state);
    const scope = requestedAction === 'submit' && state.pendingPlan ? 'submission' : 'workflow';
    const existing = scope === 'submission' ? state.pendingPlan.submissionBlock : state.workflowBlock;
    if (existing?.kind === 'sandbox-elevation' && existing.status === 'failed') {
      return { elevation: existing, shouldLog: false };
    }
    const elevation = existing?.kind === 'sandbox-elevation' ? existing : {
      kind: 'sandbox-elevation',
      label: 'sandbox elevation',
      errorId: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      attemptCount: 0,
      logged: false
    };
    elevation.status = 'required';
    elevation.action = requestedAction;
    elevation.label = `${requestedAction} sandbox elevation`;
    elevation.errorCode = error.code;
    elevation.message = requestedAction === 'submit'
      ? 'GitHub submission requires one sandbox-elevated retry.'
      : 'GitHub Project preparation requires one sandbox-elevated retry.';
    setElevation(state, scope, elevation);
    await writeState(dataDir, state);
    return { elevation, scope, shouldLog: !elevation.logged };
  });
  if (!result) return null;
  if (result.shouldLog) {
    await logError(dataDir, {
      errorId: result.elevation.errorId,
      sessionId,
      stage: 'submission-elevation',
      errorCode: 'SANDBOX_NETWORK_DENIED',
      message: result.elevation.message
    });
    await withSessionLock(dataDir, sessionId, async () => {
      const state = await readState(dataDir, sessionId);
      const location = elevationLocation(state);
      if (location?.block.errorId === result.elevation.errorId) {
        location.block.logged = true;
        await writeState(dataDir, state);
      }
    });
  }
  const superseded = await unresolvedErrors(dataDir, { sessionId, limit: 1000 });
  for (const previous of superseded) {
    if (previous.errorId === result.elevation.errorId || previous.stage !== 'background-update' ||
        !ELEVATION_CODES.has(previous.errorCode)) continue;
    await resolveError(
      dataDir,
      previous.errorId,
      'Superseded by a durable sandbox-elevation recovery request.'
    );
  }
  return result.elevation;
}

export async function beginSubmissionElevation(dataDir, sessionId, action = null) {
  return withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    const location = elevationLocation(state);
    const elevation = location?.block;
    if (!elevation || (action && locationAction(location) !== action)) return null;
    elevation.action = locationAction(location);
    elevation.status = 'in_progress';
    elevation.attemptCount = (elevation.attemptCount || 0) + 1;
    elevation.lastAttemptedAt = new Date().toISOString();
    await writeState(dataDir, state);
    return { ...elevation };
  });
}

export async function failSubmissionElevation(dataDir, sessionId, error, action = null) {
  const elevation = await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    const location = elevationLocation(state);
    const current = location?.block;
    if (!current || (action && locationAction(location) !== action)) return null;
    current.action = locationAction(location);
    current.status = 'failed';
    current.failedAt = new Date().toISOString();
    current.failureCode = error?.code || 'UNEXPECTED_ERROR';
    await writeState(dataDir, state);
    return { ...current };
  });
  if (elevation?.errorId) {
    await resolveError(dataDir, elevation.errorId, 'Sandbox-elevated retry completed with a non-sandbox failure.');
  }
  return elevation;
}

export async function resolveSubmissionElevation(dataDir, errorId) {
  if (!errorId) return null;
  return resolveError(dataDir, errorId, 'GitHub submission succeeded after sandbox elevation.');
}

export async function resolveCompletedSubmissionElevation(dataDir, sessionId) {
  const state = await readState(dataDir, sessionId);
  const completed = [
    { scope: 'submission', block: state?.completedSubmissionBlock },
    { scope: 'workflow', block: state?.completedWorkflowBlock }
  ].filter(entry => entry.block?.kind === 'sandbox-elevation' && entry.block.errorId);
  if (!completed.length) return null;
  for (const entry of completed) {
    await resolveError(
      dataDir,
      entry.block.errorId,
      locationAction(entry) === 'prepare'
        ? 'GitHub Project preparation succeeded after sandbox elevation.'
        : 'GitHub submission succeeded after sandbox elevation.'
    );
  }
  await withSessionLock(dataDir, sessionId, async () => {
    const latest = await readState(dataDir, sessionId);
    if (completed.some(entry => latest?.completedSubmissionBlock?.errorId === entry.block.errorId)) {
      latest.completedSubmissionBlock = null;
    }
    if (completed.some(entry => latest?.completedWorkflowBlock?.errorId === entry.block.errorId)) {
      latest.completedWorkflowBlock = null;
    }
    await writeState(dataDir, latest);
  });
  return completed.map(entry => entry.block.errorId);
}

export async function resolvePreparedElevation(dataDir, sessionId, action = 'prepare') {
  const completed = await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    const block = state?.workflowBlock;
    if (block?.kind !== 'sandbox-elevation' || (block.action || 'prepare') !== action) {
      return null;
    }
    state.completedWorkflowBlock = {
      ...block,
      completedAt: new Date().toISOString(),
      completionReason: 'prepared'
    };
    state.workflowBlock = null;
    await writeState(dataDir, state);
    return { ...block };
  });
  if (completed?.errorId) await resolveCompletedSubmissionElevation(dataDir, sessionId);
  return completed?.errorId || null;
}
