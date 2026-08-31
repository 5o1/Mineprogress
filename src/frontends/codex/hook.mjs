import path from 'node:path';
import process from 'node:process';
import {
  handleSessionEnd,
  handleSessionStart,
  handleTurnStop,
  handleUserPrompt
} from '../../backend/index.mjs';
import { logError } from '../../backend/errors.mjs';
import { readState } from '../../backend/state.mjs';
import { controlCommandAction } from './commands.mjs';
import { createCodexRuntime, RESOURCE_ROOT, resolveCodexDataDir } from './runtime.mjs';
import {
  isSubmissionElevationCandidate,
  pendingElevation,
  requestSubmissionElevation,
  resolveCompletedSubmissionElevation,
  submissionBlockedByElevation
} from './submission-elevation.mjs';

let hookInput = {};

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

export function normalizeCodexEvent(mode, input) {
  const prompt = input.prompt || input.user_prompt || '';
  return {
    type: mode === 'stop' ? 'turn-stop' : mode,
    sessionId: input.session_id || input.sessionId,
    turnId: input.turn_id || input.turnId || null,
    prompt,
    commandAction: mode === 'user-prompt' ? controlCommandAction(prompt) : null,
    assistantMessage: input.last_assistant_message || '',
    stopActive: Boolean(input.stop_hook_active)
  };
}

function emitCodexResult(mode, result, event, dataDir) {
  if (mode === 'session-start' && result?.restored) {
    console.log(`Mineprogress restored thread cache for session_id=${event.sessionId}, data_dir=${dataDir}. ${result.boundItemCount} item(s) bound. Project data is loaded only by explicit commands or update.`);
    return;
  }
  if (mode === 'user-prompt') {
    if (!result?.command && !result?.elevationRequest) return;
    const context = [];
    if (result?.command) {
      context.push(result.initializationRequested
        ? `Mineprogress initialization is explicitly user-triggered for session_id=${event.sessionId}, data_dir=${dataDir}. Pass data_dir to the mineprogress CLI.`
        : `Mineprogress command is explicitly user-triggered for session_id=${event.sessionId}, data_dir=${dataDir}. Pass both values to the mineprogress CLI.`);
    }
    if (result?.elevationRequest) {
      const quote = value => `"${String(value).replaceAll('"', '\\"')}"`;
      const cli = path.join(process.env.PLUGIN_ROOT || RESOURCE_ROOT, 'scripts', 'mineprogress.mjs');
      const prepare = result.elevationRequest.action === 'prepare';
      const action = prepare ? 'prepare' : 'submit';
      const reconcile = prepare ? ' --reconcile-bindings' : '';
      const command = `node ${quote(cli)} update ${action} --elevated-retry${reconcile} --session ${quote(event.sessionId)} --data-dir ${quote(dataDir)}`;
      const waiting = prepare
        ? 'a durable journal batch whose GitHub Project snapshot could not be loaded inside the sandbox'
        : 'a durable reviewed GitHub submission';
      context.push(`Mineprogress has ${waiting} awaiting sandbox elevation. Before answering the user, run this exact command once using the shell tool's sandbox-elevation mechanism: ${command}. Do not regenerate the plan, retry it inside the sandbox first, or ask the user to log in unless this elevated command reports an authentication error.`);
    }
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context.join(' ')
      }
    }));
  }
}

export async function dispatchCodexHook(mode, input, runtimeOptions = {}) {
  const dataDir = runtimeOptions.dataDir || resolveCodexDataDir([], runtimeOptions.environment || process.env);
  const event = normalizeCodexEvent(mode, input);
  if (!event.sessionId) return {};
  await resolveCompletedSubmissionElevation(dataDir, event.sessionId);
  const before = await readState(dataDir, event.sessionId);
  const existingElevation = pendingElevation(before);
  const runtime = createCodexRuntime({
    ...runtimeOptions,
    dataDir,
    sessionId: event.sessionId,
    deferSubmission: submissionBlockedByElevation(before)
  });
  let result;
  try {
    if (mode === 'session-start') result = await handleSessionStart(event, runtime);
    else if (mode === 'user-prompt') result = await handleUserPrompt(event, runtime);
    else if (mode === 'stop') result = await handleTurnStop(event, runtime);
    else if (mode === 'session-end') result = await handleSessionEnd(event, runtime);
    else throw Object.assign(new Error(`Unknown hook mode: ${mode}`), { code: 'HOOK_MODE_INVALID' });
  } catch (error) {
    if (!['user-prompt', 'session-end'].includes(mode) || !isSubmissionElevationCandidate(error)) throw error;
    const elevationRequest = await requestSubmissionElevation(dataDir, event.sessionId, error);
    if (!elevationRequest) throw error;
    return {
      elevationRequest,
      ...(event.commandAction ? {
        command: event.commandAction,
        commandAuthorized: true,
        initializationRequested: event.commandAction === 'init'
      } : {})
    };
  }
  await resolveCompletedSubmissionElevation(dataDir, event.sessionId);
  if (mode === 'user-prompt' && existingElevation) {
    return { ...result, elevationRequest: existingElevation };
  }
  return result;
}

export async function main(mode = process.argv[2]) {
  const input = await readInput();
  hookInput = input;
  const dataDir = resolveCodexDataDir();
  const event = normalizeCodexEvent(mode, input);
  const result = await dispatchCodexHook(mode, input, { dataDir });
  emitCodexResult(mode, result, event, dataDir);
}

export async function reportHookError(error) {
  try {
    const dataDir = resolveCodexDataDir();
    await logError(dataDir, {
      sessionId: hookInput.session_id || hookInput.sessionId || process.env.MINEPROGRESS_SESSION_ID || null,
      stage: 'hook',
      errorCode: error.code,
      message: error.message
    });
  } catch {}
  console.error(`mineprogress hook: ${error.message}`);
  process.exitCode = 1;
}
