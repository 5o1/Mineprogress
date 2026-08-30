import process from 'node:process';
import {
  handleSessionEnd,
  handleSessionStart,
  handleTurnStop,
  handleUserPrompt
} from '../../backend/index.mjs';
import { logError } from '../../backend/errors.mjs';
import { controlCommandAction } from './commands.mjs';
import { createCodexRuntime, resolveCodexDataDir } from './runtime.mjs';

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
    if (!result?.command) return;
    const additionalContext = result.initializationRequested
      ? `Mineprogress initialization is explicitly user-triggered for session_id=${event.sessionId}, data_dir=${dataDir}. Pass data_dir to the mineprogress CLI.`
      : `Mineprogress command is explicitly user-triggered for session_id=${event.sessionId}, data_dir=${dataDir}. Pass both values to the mineprogress CLI.`;
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext
      }
    }));
  }
}

export async function dispatchCodexHook(mode, input, runtimeOptions = {}) {
  const dataDir = runtimeOptions.dataDir || resolveCodexDataDir([], runtimeOptions.environment || process.env);
  const event = normalizeCodexEvent(mode, input);
  if (!event.sessionId) return {};
  const runtime = createCodexRuntime({ ...runtimeOptions, dataDir, sessionId: event.sessionId });
  if (mode === 'session-start') return handleSessionStart(event, runtime);
  if (mode === 'user-prompt') return handleUserPrompt(event, runtime);
  if (mode === 'stop') return handleTurnStop(event, runtime);
  if (mode === 'session-end') return handleSessionEnd(event, runtime);
  throw Object.assign(new Error(`Unknown hook mode: ${mode}`), { code: 'HOOK_MODE_INVALID' });
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
