import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

export async function renameWithRetry(rename, source, destination, {
  delays = [10, 25, 50, 100, 200],
  wait = delay => new Promise(resolve => setTimeout(resolve, delay))
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error.code) || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

export async function atomicWriteFile(file, contents, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: 'utf8', mode });
  try {
    await renameWithRetry(fs.rename, temporary, file);
  } finally {
    await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return file;
}
