import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleasePolicy } from '../scripts/validate-release.mjs';

const manifest = { name: 'mineprogress', version: '0.4.2', skills: './skills/' };
const packageJson = { name: 'mineprogress', version: '0.4.2', type: 'module' };
const previousManifest = { ...manifest, version: '0.4.1' };
const previousPackageJson = { ...packageJson, version: '0.4.1' };

function validate(overrides = {}) {
  return validateReleasePolicy({
    tag: 'v0.4.2',
    manifest,
    packageJson,
    subject: 'chore: bump to v0.4.2',
    changedFiles: ['.codex-plugin/plugin.json', 'package.json'],
    previousManifest,
    previousPackageJson,
    ...overrides
  });
}

test('release policy accepts an isolated stable version bump', () => {
  assert.deepEqual(validate(), []);
});

test('release policy rejects mixed implementation and version commits', () => {
  const errors = validate({ changedFiles: ['.codex-plugin/plugin.json', 'package.json', 'scripts/hook.mjs'] });
  assert.equal(errors.some(error => error.includes('may change only')), true);
});

test('release policy requires the dedicated bump subject and a greater stable version', () => {
  assert.equal(validate({ subject: 'fix: bump version' }).some(error => error.includes('subject')), true);
  assert.equal(validate({ previousManifest: manifest, previousPackageJson: packageJson }).some(error => error.includes('must be greater')), true);
  assert.equal(validate({ manifest: { ...manifest, version: '0.4.2-beta.1' } }).some(error => error.includes('stable X.Y.Z')), true);
});

test('release policy rejects non-version metadata changes', () => {
  const errors = validate({ manifest: { ...manifest, description: 'Unexpected release edit' } });
  assert.equal(errors.some(error => error.includes('version fields')), true);
});
