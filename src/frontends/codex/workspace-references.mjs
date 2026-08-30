import { execFile as execFileCallback } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export function normalizeGitRemote(value) {
  const remote = String(value || '').trim();
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/u.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\.git$/u, '')}`;
  try {
    const url = new URL(remote);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\.git$/u, '');
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

export async function discoverWorkspaceReferences({
  cwd = process.cwd(),
  execFileImpl = execFile
} = {}) {
  try {
    const result = await execFileImpl('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true
    });
    const link = normalizeGitRemote(result.stdout);
    return link ? [link] : [];
  } catch {
    return [];
  }
}
