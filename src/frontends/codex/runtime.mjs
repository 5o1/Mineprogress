import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { makeClient } from '../../backend/github-projects.mjs';
import { resolveGithubToken } from './github-auth.mjs';

export const RESOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function requireDataDir(env = process.env) {
  const dataDir = env.PLUGIN_DATA || env.MINEPROGRESS_DATA;
  if (!dataDir) {
    throw Object.assign(new Error('PLUGIN_DATA is required (MINEPROGRESS_DATA is accepted for local testing)'), { code: 'PLUGIN_DATA_UNAVAILABLE' });
  }
  return path.resolve(dataDir);
}

export function resolveCodexDataDir(argv = [], env = process.env) {
  const index = argv.indexOf('--data-dir');
  return index >= 0 ? path.resolve(argv[index + 1]) : requireDataDir(env);
}

export function createCodexRuntime({
  dataDir,
  sessionId,
  environment = process.env,
  resourceRoot = RESOURCE_ROOT,
  clientProvider
} = {}) {
  return {
    dataDir: dataDir || requireDataDir(environment),
    sessionId: sessionId || environment.MINEPROGRESS_SESSION_ID || null,
    environment,
    resourceRoot,
    githubClient: clientProvider || (async () => {
      const authentication = await resolveGithubToken({ env: environment });
      return makeClient(authentication.token);
    })
  };
}
