#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath } from './lib/config.mjs';
import { withSessionLock } from './lib/lock.mjs';
import {
  appendJournal,
  authorizeCommand,
  controlCommandAction,
  isControlPrompt,
  isControlTurn,
  markControlTurn,
  openSession,
  pruneStaleStates,
  readState,
  requireDataDir,
  writeState
} from './lib/state.mjs';
import { logError } from './lib/errors.mjs';
import { reconcilePendingUpdate, submitPendingUpdate } from './mineprogress.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let hookInput = {};

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

function sessionIdOf(input) {
  return input.session_id || input.sessionId;
}

async function isInitialized(dataDir) {
  try {
    await fs.access(configPath(process.env, ROOT, dataDir));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sessionStart(dataDir, input) {
  const sessionId = sessionIdOf(input);
  if (!await isInitialized(dataDir)) return;
  const state = await readState(dataDir, sessionId);
  if (!state) return;
  if (state.pendingPlan) await reconcilePendingUpdate(dataDir, sessionId);
  const configuredRetention = Number(process.env.MINEPROGRESS_STATE_RETENTION_DAYS || 30);
  await pruneStaleStates(dataDir, {
    retentionDays: Number.isFinite(configuredRetention) && configuredRetention > 0 ? configuredRetention : 30,
    keepSessionId: sessionId
  });
  if (!state.boundItems.length) return;
  console.log(`Mineprogress restored thread cache for session_id=${sessionId}, data_dir=${dataDir}. ${state.boundItems.length} item(s) bound. Project data is loaded only by explicit commands or update.`);
}

async function userPrompt(dataDir, input) {
  const sessionId = sessionIdOf(input);
  const prompt = input.prompt || input.user_prompt || '';
  const control = isControlPrompt(prompt);
  const action = controlCommandAction(prompt);
  const initialized = await isInitialized(dataDir);
  const existing = await readState(dataDir, sessionId);
  if (!control && (!initialized || !existing?.boundItems.length)) return;
  if (control && action === 'init') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Mineprogress initialization is explicitly user-triggered for session_id=${sessionId}, data_dir=${dataDir}. Pass data_dir to the mineprogress CLI.`
      }
    }));
    return;
  }
  await withSessionLock(dataDir, sessionId, async () => {
    const { state } = await openSession(dataDir, sessionId);
    if (control) {
      markControlTurn(state, input.turn_id);
      authorizeCommand(state, action, input.turn_id);
    }
    appendJournal(state, { kind: 'user', turnId: input.turn_id, text: prompt, control });
    await writeState(dataDir, state);
  });
  if (control) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Mineprogress command is explicitly user-triggered for session_id=${sessionId}, data_dir=${dataDir}. Pass both values to the mineprogress CLI.`
      }
    }));
  }
}

async function stop(dataDir, input) {
  const sessionId = sessionIdOf(input);
  if (input.stop_hook_active) return;
  if (!await isInitialized(dataDir)) return;
  await withSessionLock(dataDir, sessionId, async () => {
    const state = await readState(dataDir, sessionId);
    if (!state?.boundItems.length) return;
    appendJournal(state, {
      kind: 'assistant',
      turnId: input.turn_id,
      text: input.last_assistant_message || '',
      control: isControlTurn(state, input.turn_id)
    });
    if (state.boundItems.length && state.journal.length) {
      state.backgroundRequestedThrough = state.journal.at(-1).sequence;
    }
    await writeState(dataDir, state);
  });
}

async function sessionEnd(dataDir, input) {
  const sessionId = sessionIdOf(input);
  if (!await isInitialized(dataDir)) return;
  const state = await withSessionLock(dataDir, sessionId, async () => {
    const current = await readState(dataDir, sessionId);
    if (!current || (!current.boundItems.length && !current.pendingPlan)) return null;
    current.lastEndedAt = new Date().toISOString();
    await writeState(dataDir, current);
    return current;
  });
  if (!state) return;
  if (state.pendingPlan) await submitPendingUpdate(dataDir, sessionId, { verify: false });
}

async function main() {
  const mode = process.argv[2];
  const input = await readInput();
  hookInput = input;
  const dataDir = requireDataDir();
  if (mode === 'session-start') return sessionStart(dataDir, input);
  if (mode === 'user-prompt') return userPrompt(dataDir, input);
  if (mode === 'stop') return stop(dataDir, input);
  if (mode === 'session-end') return sessionEnd(dataDir, input);
  throw Object.assign(new Error(`Unknown hook mode: ${mode}`), { code: 'HOOK_MODE_INVALID' });
}

main().catch(async error => {
  try {
    await logError(requireDataDir(), {
      sessionId: sessionIdOf(hookInput) || process.env.MINEPROGRESS_SESSION_ID || null,
      stage: 'hook',
      errorCode: error.code,
      message: error.message
    });
  } catch {}
  console.error(`mineprogress hook: ${error.message}`);
  process.exitCode = 1;
});
