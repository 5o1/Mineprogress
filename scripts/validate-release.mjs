#!/usr/bin/env node
import fs from 'node:fs/promises';

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
const manifest = JSON.parse(await fs.readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!tag || tag !== `v${manifest.version}` || packageJson.version !== manifest.version) {
  console.error(`Release tag ${tag || '(missing)'} must equal v${manifest.version}, and package.json must match.`);
  process.exit(1);
}
console.log(`Release ${tag} is version-consistent.`);
