import crypto from 'node:crypto';
import { logError, resolveError } from '../../backend/errors.mjs';
import { withSessionLock } from '../../backend/lock.mjs';
import { readState, writeState } from '../../backend/state.mjs';

const ELEVATION_CODES = new Set(['SANDBOX_DENIED', 'GH_NETWORK_ERROR']);
const RETRYABLE_STATES = new Set(['required', 'in_progress']);

export function isSubmissionElevationCandidate(error) {
  return ELEVATION_CODES.has(error?.code);
}

export function pendingSubmissionElevation(state) {
  const block = state?.pendingPlan?.submissionBlock;
  return block?.kind === 'sandbox-elevation' && RETRYABLE_STATES.has(block.status) ? block : null;
}

export function submissionBlockedByElevation(state) {
  return state?.pendingPlan?.submissionBlock?.kind === 'sandbox-elevation';
}

export async function requestSubmissionElevation(dataDir, sessionId, error) {
  if (!isSubmissionElevationCandidate(error)) return null;
  const result = await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    if (!state?.pendingPlan) return null;
    const existing = state.pendingPlan.submissionBlock;
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
    elevation.label = 'sandbox elevation';
    elevation.errorCode = error.code;
    elevation.message = 'GitHub submission requires one sandbox-elevated retry.';
    state.pendingPlan.submissionBlock = elevation;
    await writeState(dataDir, state);
    return { elevation, shouldLog: !elevation.logged };
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
      if (state?.pendingPlan?.submissionBlock?.errorId === result.elevation.errorId) {
        state.pendingPlan.submissionBlock.logged = true;
        await writeState(dataDir, state);
      }
    });
  }
  return result.elevation;
}

export async function beginSubmissionElevation(dataDir, sessionId) {
  return withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    const elevation = state?.pendingPlan?.submissionBlock;
    if (elevation?.kind !== 'sandbox-elevation') return null;
    elevation.status = 'in_progress';
    elevation.attemptCount = (elevation.attemptCount || 0) + 1;
    elevation.lastAttemptedAt = new Date().toISOString();
    await writeState(dataDir, state);
    return { ...elevation };
  });
}

export async function failSubmissionElevation(dataDir, sessionId, error) {
  const elevation = await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    const current = state?.pendingPlan?.submissionBlock;
    if (current?.kind !== 'sandbox-elevation') return null;
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
  const completed = state?.completedSubmissionBlock;
  if (completed?.kind !== 'sandbox-elevation' || !completed.errorId) return null;
  await resolveSubmissionElevation(dataDir, completed.errorId);
  await withSessionLock(dataDir, sessionId, async () => {
    const latest = await readState(dataDir, sessionId);
    if (latest?.completedSubmissionBlock?.errorId === completed.errorId) {
      latest.completedSubmissionBlock = null;
      await writeState(dataDir, latest);
    }
  });
  return completed.errorId;
}
