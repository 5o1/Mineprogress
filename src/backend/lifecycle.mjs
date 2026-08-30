import fs from 'node:fs/promises';
import { assertHostEvent } from '../host/contract.mjs';
import { calendarDate } from './calendar.mjs';
import { configPath, loadConfig } from './config.mjs';
import { isCompletionDeclaration } from './intent.mjs';
import { submitPendingUpdate } from './application.mjs';
import { withSessionLock } from './lock.mjs';
import {
  appendJournal,
  authorizeCommand,
  isControlTurn,
  markControlTurn,
  openSession,
  pruneStaleStates,
  readState,
  recordStatusIntent,
  writeState
} from './state.mjs';

async function isInitialized(runtime) {
  try {
    await fs.access(configPath(runtime.environment || {}, runtime.resourceRoot, runtime.dataDir));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function handleSessionStart(event, runtime) {
  assertHostEvent(event);
  if (!await isInitialized(runtime)) return {};
  const state = await readState(runtime.dataDir, event.sessionId);
  if (!state) return {};
  const configuredRetention = Number(runtime.environment?.MINEPROGRESS_STATE_RETENTION_DAYS || 30);
  await pruneStaleStates(runtime.dataDir, {
    retentionDays: Number.isFinite(configuredRetention) && configuredRetention > 0 ? configuredRetention : 30,
    keepSessionId: event.sessionId
  });
  if (!state.boundItems.length) return {};
  return { restored: true, boundItemCount: state.boundItems.length };
}

export async function handleUserPrompt(event, runtime) {
  assertHostEvent(event);
  const control = Boolean(event.commandAction);
  const action = event.commandAction;
  const initialized = await isInitialized(runtime);
  const existing = await readState(runtime.dataDir, event.sessionId);
  if (!control && (!initialized || (!existing?.boundItems.length && !existing?.pendingPlan))) return {};
  if (control && action === 'init') {
    return { command: action, initializationRequested: true };
  }
  const currentDate = calendarDate(typeof runtime.now === 'function' ? runtime.now() : new Date());
  const completionDeclaration = !control && isCompletionDeclaration(event.prompt);
  const config = initialized && completionDeclaration
    ? await loadConfig(configPath(runtime.environment || {}, runtime.resourceRoot, runtime.dataDir))
    : null;
  let dailySubmission = null;
  if (initialized && existing?.pendingPlan && existing.dailySubmissionDate !== currentDate) {
    dailySubmission = await submitPendingUpdate(runtime.dataDir, event.sessionId, { verify: true }, runtime);
  }
  await withSessionLock(runtime.dataDir, event.sessionId, async () => {
    const { state } = await openSession(runtime.dataDir, event.sessionId);
    if (dailySubmission?.verified) state.dailySubmissionDate = currentDate;
    if (control) {
      markControlTurn(state, event.turnId);
      authorizeCommand(state, action, event.turnId);
    }
    const journalEvent = appendJournal(state, { kind: 'user', turnId: event.turnId, text: event.prompt, control });
    if (journalEvent && state.boundItems.length === 1 && completionDeclaration) {
      const targetStatus = config?.kanban?.statusRoles?.completed || config?.kanban?.terminalStatuses?.[0];
      if (targetStatus) recordStatusIntent(
        state,
        state.boundItems[0].itemId,
        targetStatus,
        journalEvent.sequence,
        { role: 'completed' }
      );
    }
    await writeState(runtime.dataDir, state);
  });
  return {
    ...(control ? { command: action, commandAuthorized: true } : {}),
    ...(dailySubmission ? { dailySubmission } : {})
  };
}

export async function handleTurnStop(event, runtime) {
  assertHostEvent(event);
  if (event.stopActive || !await isInitialized(runtime)) return {};
  await withSessionLock(runtime.dataDir, event.sessionId, async () => {
    const state = await readState(runtime.dataDir, event.sessionId);
    if (!state?.boundItems.length) return;
    appendJournal(state, {
      kind: 'assistant',
      turnId: event.turnId,
      text: event.assistantMessage,
      control: isControlTurn(state, event.turnId)
    });
    if (state.journal.length) state.backgroundRequestedThrough = state.journal.at(-1).sequence;
    await writeState(runtime.dataDir, state);
  });
  return {};
}

export async function handleSessionEnd(event, runtime) {
  assertHostEvent(event);
  if (!await isInitialized(runtime)) return {};
  const state = await withSessionLock(runtime.dataDir, event.sessionId, async () => {
    const current = await readState(runtime.dataDir, event.sessionId);
    if (!current || (!current.boundItems.length && !current.pendingPlan)) return null;
    current.lastEndedAt = new Date().toISOString();
    await writeState(runtime.dataDir, current);
    return current;
  });
  if (state?.pendingPlan) await submitPendingUpdate(runtime.dataDir, event.sessionId, { verify: false }, runtime);
  return {};
}
