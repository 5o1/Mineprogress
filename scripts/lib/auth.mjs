import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

const execFile = promisify(execFileCallback);

export async function resolveGithubToken({
  env = process.env,
  execFileImpl = execFile
} = {}) {
  let ghUnavailable = env.MINEPROGRESS_DISABLE_GH_AUTH === '1';
  if (!ghUnavailable) {
    try {
      const result = await execFileImpl('gh', ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 4096,
        windowsHide: true
      });
      const token = String(result.stdout || '').trim();
      if (token) return { token, source: 'gh' };
    } catch (error) {
      ghUnavailable = error?.code === 'ENOENT';
    }
  }

  const environmentToken = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (environmentToken) return { token: environmentToken, source: 'environment' };

  if (!ghUnavailable && !env.MINEPROGRESS_ELEVATED_RETRY) {
    throw Object.assign(new Error('GitHub CLI authentication may be hidden by the sandbox; retry once with elevation.'), { code: 'SANDBOX_DENIED' });
  }
  throw Object.assign(new Error('Log in with gh auth login, or set GITHUB_TOKEN/GH_TOKEN.'), { code: 'GH_TOKEN_MISSING' });
}
