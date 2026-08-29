import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const METADATA_VERSION = 1;

export function projectCacheKey(config) {
  return crypto.createHash('sha256')
    .update(`${config.ownerType}:${config.owner}:${config.projectNumber}:${config.defaultRepository || ''}`)
    .digest('hex');
}

export function metadataPath(dataDir) {
  return path.join(dataDir, 'cache', 'project-metadata.json');
}

async function readAll(dataDir) {
  try {
    const value = JSON.parse(await fs.readFile(metadataPath(dataDir), 'utf8'));
    return value.version === METADATA_VERSION ? value : { version: METADATA_VERSION, projects: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: METADATA_VERSION, projects: {} };
    throw error;
  }
}

export async function readProjectMetadata(dataDir, config) {
  return (await readAll(dataDir)).projects[projectCacheKey(config)] || null;
}

export async function updateProjectMetadata(dataDir, config, patch) {
  const all = await readAll(dataDir);
  const key = projectCacheKey(config);
  all.projects[key] = {
    ...all.projects[key],
    ...patch,
    checkedAt: new Date().toISOString()
  };
  const file = metadataPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
  return all.projects[key];
}
