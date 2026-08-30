import path from 'node:path';
import process from 'node:process';
import { loadConfig as loadBackendConfig } from '../../src/backend/config.mjs';

export * from '../../src/backend/config.mjs';

export function configPath(env = process.env, cwd = process.cwd(), dataDir) {
  if (env.MINEPROGRESS_CONFIG || env.GITHUB_PROJECTS_CONFIG) {
    return env.MINEPROGRESS_CONFIG || env.GITHUB_PROJECTS_CONFIG;
  }
  if (dataDir) return path.join(dataDir, 'config.json');
  return path.join(env.PLUGIN_ROOT || cwd, 'config.json');
}

export async function loadConfig(file = configPath()) {
  return loadBackendConfig(file);
}
