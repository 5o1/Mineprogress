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
import {
  beginSubmissionElevation,
  failSubmissionElevation,
  isSubmissionElevationCandidate,
  requestSubmissionElevation,
  resolveCompletedSubmissionElevation
} from './submission-elevation.mjs';

export { parseProjectUrl, resolveInitializationCreationRepository };

async function executeWithElevation({ dataDir, sessionId, elevatedRetry, execute }) {
  if (sessionId) await resolveCompletedSubmissionElevation(dataDir, sessionId);
  if (elevatedRetry && sessionId) await beginSubmissionElevation(dataDir, sessionId);
  try {
    const result = await execute();
    if (sessionId) await resolveCompletedSubmissionElevation(dataDir, sessionId);
    return result;
  } catch (error) {
    if (elevatedRetry && sessionId) await failSubmissionElevation(dataDir, sessionId, error);
    throw error;
  }
}

export async function run(argv = process.argv.slice(2), options = {}) {
  const elevatedRetry = argv.includes('--elevated-retry');
  if (elevatedRetry && !(argv[0] === 'update' && argv[1] === 'submit')) {
    throw Object.assign(new Error('--elevated-retry is valid only for update submit.'), { code: 'ELEVATED_RETRY_INVALID' });
  }
  const effectiveArgv = argv.filter(value => value !== '--elevated-retry');
  const environment = elevatedRetry
    ? { ...(options.environment || process.env), MINEPROGRESS_ELEVATED_RETRY: '1' }
    : options.environment || process.env;
  const dataDir = options.dataDir || resolveCodexDataDir(effectiveArgv, environment);
  const { flags } = parseCommandArgs(effectiveArgv.slice(1));
  const sessionId = flags.session || options.sessionId || environment.MINEPROGRESS_SESSION_ID || null;
  const runtime = createCodexRuntime({ ...options, environment, dataDir, sessionId });
  return executeWithElevation({
    dataDir,
    sessionId,
    elevatedRetry,
    execute: () => runBackend(effectiveArgv, runtime)
  });
}

export async function reconcilePendingUpdate(dataDir, sessionId, options = {}, runtimeOptions = {}) {
  const runtime = createCodexRuntime({ ...runtimeOptions, dataDir, sessionId });
  return reconcileBackendUpdate(dataDir, sessionId, options, runtime);
}

export async function submitPendingUpdate(dataDir, sessionId, options = {}, runtimeOptions = {}) {
  const elevatedRetry = Boolean(options.elevatedRetry);
  const environment = elevatedRetry
    ? { ...(runtimeOptions.environment || process.env), MINEPROGRESS_ELEVATED_RETRY: '1' }
    : runtimeOptions.environment || process.env;
  const runtime = createCodexRuntime({ ...runtimeOptions, environment, dataDir, sessionId });
  const backendOptions = { ...options };
  delete backendOptions.elevatedRetry;
  return executeWithElevation({
    dataDir,
    sessionId,
    elevatedRetry,
    execute: () => submitBackendUpdate(dataDir, sessionId, backendOptions, runtime)
  });
}

export async function main(argv = process.argv.slice(2)) {
  const elevatedRetry = argv.includes('--elevated-retry');
  const effectiveArgv = argv.filter(value => value !== '--elevated-retry');
  try {
    const result = await run(argv);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const classification = classifyError(error);
    if (isSubmissionElevationCandidate(error) && !elevatedRetry && !process.env.MINEPROGRESS_ELEVATED_RETRY) {
      try {
        const { flags } = parseCommandArgs(effectiveArgv.slice(1));
        const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : resolveCodexDataDir(effectiveArgv, process.env);
        const sessionId = flags.session || process.env.MINEPROGRESS_SESSION_ID || null;
        if (sessionId) await requestSubmissionElevation(dataDir, sessionId, error);
      } catch {}
      console.error(JSON.stringify({ errorCode: error.code, requestElevation: true, message: 'Retry this exact command once with sandbox elevation.' }));
      process.exitCode = 77;
      return;
    }
    try {
      const { flags } = parseCommandArgs(effectiveArgv.slice(1));
      const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : resolveCodexDataDir(effectiveArgv);
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
