import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { configPath, createConfig, loadConfig, saveConfig } from '../scripts/lib/config.mjs';

test('legacy config wrapper loads the environment-selected path without arguments', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-config-compat-'));
  const file = path.join(directory, 'private-config.json');
  const previous = process.env.MINEPROGRESS_CONFIG;
  try {
    await saveConfig(file, createConfig({ owner: '5o1', projectNumber: 2 }));
    process.env.MINEPROGRESS_CONFIG = file;
    const config = await loadConfig();
    assert.equal(config.owner, '5o1');
    assert.equal(config.projectNumber, 2);
  } finally {
    if (previous === undefined) delete process.env.MINEPROGRESS_CONFIG;
    else process.env.MINEPROGRESS_CONFIG = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('legacy config path still honors PLUGIN_ROOT when no data directory is supplied', () => {
  const root = path.resolve('legacy-plugin-root');
  assert.equal(configPath({ PLUGIN_ROOT: root }, path.resolve('fallback')), path.join(root, 'config.json'));
});
