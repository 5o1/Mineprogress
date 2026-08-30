import path from 'node:path';
import process from 'node:process';
import { classifyError, logError } from '../../backend/errors.mjs';
import { readState } from '../../backend/state.mjs';
import {
  parseProjectUrl,
  parseCommandArgs,
  reconcilePendingUpdate as reconcileBackendUpdate,
  resolveInitializationCreationRepository,
  runBackend,
  submitPendingUpdate as submitBackendUpdate
} from '../../backend/index.mjs';
import { createCodexRuntime, resolveCodexDataDir } from './runtime.mjs';

export { parseProjectUrl, resolveInitializationCreationRepository };

export async function run(argv = process.argv.slice(2), options = {}) {
  const dataDir = options.dataDir || resolveCodexDataDir(argv, options.environment || process.env);
  const runtime = createCodexRuntime({ ...options, dataDir });
  return runBackend(argv, runtime);
}

export async function reconcilePendingUpdate(dataDir, sessionId, options = {}, runtimeOptions = {}) {
  const runtime = createCodexRuntime({ ...runtimeOptions, dataDir, sessionId });
  return reconcileBackendUpdate(dataDir, sessionId, options, runtime);
}

export async function submitPendingUpdate(dataDir, sessionId, options = {}, runtimeOptions = {}) {
  const runtime = createCodexRuntime({ ...runtimeOptions, dataDir, sessionId });
  return submitBackendUpdate(dataDir, sessionId, options, runtime);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await run(argv);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const classification = classifyError(error);
    if (classification.sandboxDenied && !process.env.MINEPROGRESS_ELEVATED_RETRY) {
      console.error(JSON.stringify({ errorCode: error.code, requestElevation: true, message: 'Retry this exact command once with sandbox elevation.' }));
      process.exitCode = 77;
      return;
    }
    try {
      const { flags } = parseCommandArgs(argv.slice(1));
      const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : resolveCodexDataDir(argv);
      const sessionId = flags.session || process.env.MINEPROGRESS_SESSION_ID || null;
      const state = sessionId ? await readState(dataDir, sessionId).catch(() => null) : null;
      await logError(dataDir, {
        sessionId,
        updateRunId: state?.activeUpdate?.runId || null,
        stage: 'command',
        errorCode: classification.code,
        message: error.message
      });
    } catch {}
    console.error(JSON.stringify({ errorCode: classification.code, message: error.message }));
    process.exitCode = 1;
  }
}
