import { spawn } from 'node:child_process';
import process from 'node:process';

export async function reexecWithEnvironmentProxy({
  env = process.env,
  argv = process.argv,
  execArgv = process.execArgv,
  execPath = process.execPath,
  allowedFlags = process.allowedNodeEnvironmentFlags,
  spawnProcess = spawn
} = {}) {
  const proxyConfigured = Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
  if (!proxyConfigured || env.MINEPROGRESS_ENV_PROXY_ACTIVE === '1' ||
      execArgv.includes('--use-env-proxy') || !allowedFlags?.has('--use-env-proxy')) return null;
  const child = spawnProcess(execPath, ['--use-env-proxy', ...execArgv, ...argv.slice(1)], {
    env: { ...env, MINEPROGRESS_ENV_PROXY_ACTIVE: '1' },
    stdio: 'inherit',
    windowsHide: true
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
