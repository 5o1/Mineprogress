#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath } from './lib/config.mjs';
import {
  appendJournal,
  authorizeCommand,
  beginUpdate,
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
  if (!state?.boundItems.length) return;
  if (state.pendingPlan) await reconcilePendingUpdate(dataDir, sessionId);
  const configuredRetention = Number(process.env.MINEPROGRESS_STATE_RETENTION_DAYS || 30);
  await pruneStaleStates(dataDir, {
    retentionDays: Number.isFinite(configuredRetention) && configuredRetention > 0 ? configuredRetention : 30,
    keepSessionId: sessionId
  });
  console.log(`Mineprogress restored thread cache for session_id=${sessionId}, data_dir=${dataDir}. ${state.boundItems.length} item(s) bound. Project data is loaded only by explicit commands or update.`);
}

async function userPrompt(dataDir, input) {
  const sessionId = sessionIdOf(input);
  const prompt = input.prompt || input.user_prompt || '';
  const control = isControlPrompt(prompt);
  const action = controlCommandAction(prompt);
  const initialized = await isInitialized(dataDir);
  let state = await readState(dataDir, sessionId);
  if (!control && (!initialized || !state?.boundItems.length)) return;
  if (control && action === 'init') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Mineprogress initialization is explicitly user-triggered for session_id=${sessionId}, data_dir=${dataDir}. Pass data_dir to the mineprogress CLI.`
      }
    }));
    return;
  }
  if (control && !state) ({ state } = await openSession(dataDir, sessionId));
  if (control) {
    markControlTurn(state, input.turn_id);
    authorizeCommand(state, action, input.turn_id);
  }
  appendJournal(state, { kind: 'user', turnId: input.turn_id, text: prompt, control });
  await writeState(dataDir, state);
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
  const state = await readState(dataDir, sessionId);
  if (!state?.boundItems.length) return;
  appendJournal(state, {
    kind: 'assistant',
    turnId: input.turn_id,
    text: input.last_assistant_message || '',
    control: isControlTurn(state, input.turn_id)
  });
  if (state.pendingPlan?.attempts?.length) {
    await writeState(dataDir, state);
    return;
  }
  const run = beginUpdate(state);
  if (!run) {
    await writeState(dataDir, state);
    return;
  }
  if (run.exhausted) {
    await writeState(dataDir, state);
    return;
  }
  await writeState(dataDir, state);
  console.log(JSON.stringify({
    decision: 'block',
    reason: `Mineprogress has an incremental plan revision pending for ${state.boundItems.length} bound item(s). Run node \"${path.join(ROOT, 'scripts', 'mineprogress.mjs')}\" update prepare --session \"${sessionId}\" --data-dir \"${dataDir}\". Consolidate existingPlan with only the returned incremental context, run update stage, delegate approve/reject review to a separate reviewer subagent, then run update apply to store the reviewed plan without writing GitHub. Allow at most five content rounds. Do not run update submit, create, bind, or unbind. Keep a successful automatic plan revision silent; surface only a failure.`
  }));
}

async function sessionEnd(dataDir, input) {
  const sessionId = sessionIdOf(input);
  if (!await isInitialized(dataDir)) return;
  const state = await readState(dataDir, sessionId);
  if (!state || (!state.boundItems.length && !state.pendingPlan)) return;
  state.lastEndedAt = new Date().toISOString();
  await writeState(dataDir, state);
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
