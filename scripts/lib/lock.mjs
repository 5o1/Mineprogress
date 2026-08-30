import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function lockPath(dataDir, sessionId, kind) {
  const key = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(path.resolve(dataDir), 'locks', `${key}.${kind}.lock`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function removeAbandonedLock(file, staleAfterMs) {
  let record;
  try {
    record = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
  }
  const age = Date.now() - Date.parse(record?.createdAt || 0);
  if (processIsAlive(record?.pid) && age < staleAfterMs) return false;
  await fs.unlink(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}

export async function acquireSessionLock(dataDir, sessionId, kind, {
  waitMs = 5_000,
  staleAfterMs = 30 * 60 * 1_000
} = {}) {
  const file = lockPath(dataDir, sessionId, kind);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await fs.unlink(file).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await removeAbandonedLock(file, staleAfterMs)) continue;
      if (Date.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export async function withSessionLock(dataDir, sessionId, callback, options) {
  const release = await acquireSessionLock(dataDir, sessionId, 'state', options);
  if (!release) throw Object.assign(new Error('Thread state is busy.'), { code: 'STATE_BUSY' });
  try {
    return await callback();
  } finally {
    await release();
  }
}
