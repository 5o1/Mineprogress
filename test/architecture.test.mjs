import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { executeBackend } from '../src/backend/index.mjs';
import { createConfig, saveConfig } from '../src/backend/config.mjs';
import { assertHostEvent, validateHostManifest } from '../src/host/contract.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (entry.name.endsWith('.mjs')) files.push(absolute);
  }
  return files;
}

test('backend source has no host-platform dependencies', async () => {
  const forbidden = /Codex|codex|Claude|claude|OpenClaw|openclaw|hookSpecificOutput|PLUGIN_ROOT|PLUGIN_DATA|last_assistant_message|stop_hook_active|\$mineprogress|\bsession_id\b|\bturn_id\b/u;
  for (const file of await sourceFiles(path.join(ROOT, 'src', 'backend'))) {
    const source = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(source, forbidden, path.relative(ROOT, file));
    assert.doesNotMatch(source, /(?:\.\.\/)+frontends\//u, path.relative(ROOT, file));
  }
});

test('host adapter manifests share one versioned contract', async () => {
  for (const id of ['codex', 'claude-code', 'openclaw']) {
    const file = path.join(ROOT, 'platforms', id, 'adapter.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(validateHostManifest(manifest), [], id);
    assert.equal(manifest.id, id);
    if (manifest.status === 'implemented') {
      for (const target of Object.values(manifest.entrypoints)) await fs.access(path.join(ROOT, target));
      for (const target of Object.values(manifest.resources)) await fs.access(path.join(ROOT, target));
    } else {
      assert.equal(manifest.entrypoints, undefined, 'planned adapters must not claim executable support');
    }
  }
});

test('normalized host events reject raw or incomplete platform payloads', () => {
  assert.equal(assertHostEvent({ type: 'session-start', sessionId: 'thread-1' }).sessionId, 'thread-1');
  assert.throws(() => assertHostEvent({ type: 'Stop', session_id: 'thread-1' }), { code: 'HOST_EVENT_INVALID' });
  assert.throws(() => assertHostEvent({ type: 'turn-stop', sessionId: 'thread-1' }), { code: 'HOST_EVENT_INVALID' });
});

test('host adapters can call the backend with a structured command request', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineprogress-host-'));
  try {
    await saveConfig(path.join(dataDir, 'config.json'), createConfig({ owner: '5o1', projectNumber: 2 }));
    const result = await executeBackend({ command: 'settings' }, {
      dataDir,
      resourceRoot: ROOT,
      environment: {},
      githubClient: async () => { throw new Error('settings must remain offline'); }
    });
    assert.equal(result.update.maxReviewAttempts, 5);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
