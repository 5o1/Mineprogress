#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

function withoutVersion(value) {
  const copy = structuredClone(value);
  delete copy.version;
  return copy;
}

function stableVersion(value) {
  const match = String(value || '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? match.slice(1).map(Number) : null;
}

function isGreaterVersion(next, previous) {
  return next.some((part, index) => part > previous[index] && next.slice(0, index).every((value, prior) => value === previous[prior]));
}

export function validateReleasePolicy({ tag, manifest, packageJson, subject, changedFiles, previousManifest, previousPackageJson }) {
  const errors = [];
  const version = manifest.version;
  if (!tag || tag !== `v${version}` || packageJson.version !== version) {
    errors.push(`Release tag ${tag || '(missing)'} must equal v${version}, and package.json must match.`);
  }
  const nextVersion = stableVersion(version);
  const priorVersion = stableVersion(previousManifest.version);
  if (!nextVersion || !priorVersion) errors.push('Formal releases require stable X.Y.Z versions.');
  else if (!isGreaterVersion(nextVersion, priorVersion)) errors.push(`Version ${version} must be greater than ${previousManifest.version}.`);
  if (previousPackageJson.version !== previousManifest.version) errors.push('Parent manifest and package versions must match.');
  if (subject !== `chore: bump to v${version}`) errors.push(`Release commit subject must be exactly: chore: bump to v${version}`);
  const expectedFiles = ['.codex-plugin/plugin.json', 'package.json'];
  if (!isDeepStrictEqual([...changedFiles].sort(), expectedFiles)) {
    errors.push(`Release commit may change only: ${expectedFiles.join(', ')}.`);
  }
  if (!isDeepStrictEqual(withoutVersion(manifest), withoutVersion(previousManifest)) ||
      !isDeepStrictEqual(withoutVersion(packageJson), withoutVersion(previousPackageJson))) {
    errors.push('Release commit may change only the version fields.');
  }
  return errors;
}

async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
  const readJson = relative => fs.readFile(path.join(root, relative), 'utf8').then(JSON.parse);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const [manifest, packageJson] = await Promise.all([
    readJson('.codex-plugin/plugin.json'),
    readJson('package.json')
  ]);
  const previousManifest = JSON.parse(git(['show', 'HEAD^:.codex-plugin/plugin.json']));
  const previousPackageJson = JSON.parse(git(['show', 'HEAD^:package.json']));
  const errors = validateReleasePolicy({
    tag,
    manifest,
    packageJson,
    subject: git(['log', '-1', '--pretty=%s', 'HEAD']),
    changedFiles: git(['diff', '--name-only', 'HEAD^', 'HEAD']).split(/\r?\n/u).filter(Boolean),
    previousManifest,
    previousPackageJson
  });
  if (errors.length) {
    for (const error of errors) console.error(`release: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Release ${tag} is an isolated stable version bump.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) await main();
