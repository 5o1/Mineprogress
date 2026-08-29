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
  completeUpdate,
  controlCommandAction,
  isControlPrompt,
  isControlTurn,
  markControlTurn,
  openSession,
  pruneStaleStates,
  requireDataDir,
  writeState
} from './lib/state.mjs';
import { logError } from './lib/errors.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

function sessionIdOf(input) {
  return input.session_id || input.sessionId;
}

async function sessionStart(dataDir, input) {
  const sessionId = sessionIdOf(input);
  const configuredRetention = Number(process.env.MINEPROGRESS_STATE_RETENTION_DAYS || 30);
  await pruneStaleStates(dataDir, {
    retentionDays: Number.isFinite(configuredRetention) && configuredRetention > 0 ? configuredRetention : 30,
    keepSessionId: sessionId
  });
  const { state, restored } = await openSession(dataDir, sessionId);
  let initialized = true;
  try { await fs.access(configPath(process.env, ROOT, dataDir)); } catch { initialized = false; }
  console.log(`Mineprogress ${restored ? 'restored' : 'created'} thread cache for session_id=${sessionId}, data_dir=${dataDir}. ${state.boundItems.length} item(s) bound. ${initialized ? 'Configuration is available.' : 'Run $mineprogress init to configure the plugin.'} Project data is loaded only by explicit commands or update.`);
}

async function userPrompt(dataDir, input) {
  const sessionId = sessionIdOf(input);
  const { state } = await openSession(dataDir, sessionId);
  const prompt = input.prompt || input.user_prompt || '';
  const control = isControlPrompt(prompt);
  if (control) {
    markControlTurn(state, input.turn_id);
    authorizeCommand(state, controlCommandAction(prompt), input.turn_id);
  }
  appendJournal(state, { kind: 'user', turnId: input.turn_id, text: prompt, control });
  await writeState(dataDir, state);
  if (control) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Mineprogress command is explicitly user-triggered for session_id=${sessionId}. Pass this session id to the mineprogress CLI.`
      }
    }));
  }
}

async function stop(dataDir, input) {
  const sessionId = sessionIdOf(input);
  const { state } = await openSession(dataDir, sessionId);
  if (input.stop_hook_active) return;
  appendJournal(state, {
    kind: 'assistant',
    turnId: input.turn_id,
    text: input.last_assistant_message || '',
    control: isControlTurn(state, input.turn_id)
  });
  const run = beginUpdate(state);
  if (!run) {
    await writeState(dataDir, state);
    return;
  }
  if (run.exhausted) {
    await writeState(dataDir, state);
    return;
  }
  if (!state.boundItems.length) {
    completeUpdate(state, run.runId);
    await writeState(dataDir, state);
    return;
  }
  await writeState(dataDir, state);
  console.log(JSON.stringify({
    decision: 'block',
    reason: `Mineprogress has an incremental update pending for ${state.boundItems.length} bound item(s). Run node \"${path.join(ROOT, 'scripts', 'mineprogress.mjs')}\" update prepare --session \"${sessionId}\" --data-dir \"${dataDir}\". Generate with the returned update model, run update stage, delegate approve/reject review to a separate reviewer subagent, then run update apply. Allow at most five content rounds. Do not create, bind, or unbind items. Keep a successful automatic update silent; surface only a failure.`
  }));
}

async function sessionEnd(dataDir, input) {
  const sessionId = sessionIdOf(input);
  const { state } = await openSession(dataDir, sessionId);
  state.lastEndedAt = new Date().toISOString();
  await writeState(dataDir, state);
}

async function main() {
  const mode = process.argv[2];
  const input = await readInput();
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
      sessionId: process.env.MINEPROGRESS_SESSION_ID || null,
      stage: 'hook',
      errorCode: error.code,
      message: error.message
    });
  } catch {}
  console.error(`mineprogress hook: ${error.message}`);
  process.exitCode = 1;
});
