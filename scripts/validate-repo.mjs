#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = relative => fs.readFile(path.join(root, relative), 'utf8');
const errors = [];

const [manifest, packageJson, hooks, example, skill, readme, configuration, workflow, development, releaseWorkflow] = await Promise.all([
  read('.codex-plugin/plugin.json').then(JSON.parse),
  read('package.json').then(JSON.parse),
  read('hooks/hooks.json').then(JSON.parse),
  read('config.example.json').then(JSON.parse),
  read('skills/mineprogress/SKILL.md'),
  read('README.md'),
  read('docs/configuration.md'),
  read('docs/workflow.md'),
  read('docs/development.md'),
  read('.github/workflows/release.yml')
]);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) errors.push('Manifest version is not strict semver.');
if (manifest.version !== packageJson.version) errors.push('Manifest and package versions differ.');
if (manifest.name !== packageJson.name) errors.push('Manifest and package names differ.');
if (!skill.includes('allow_implicit_invocation: false')) errors.push('Mineprogress skill must require explicit invocation.');
if (!hooks.hooks?.SessionStart || !hooks.hooks?.UserPromptSubmit || !hooks.hooks?.Stop || !hooks.hooks?.SessionEnd) {
  errors.push('Required lifecycle hooks are missing.');
}
for (const group of Object.values(hooks.hooks || {})) {
  for (const matcher of group) {
    for (const hook of matcher.hooks || []) {
      if (hook.type !== 'command' || !hook.command.includes('${PLUGIN_ROOT}')) errors.push('Hook commands must use PLUGIN_ROOT.');
    }
  }
}
if (example.models?.review?.model !== 'gpt-5.6-luna' || example.models?.review?.reasoningEffort !== 'medium') {
  errors.push('Default review model must be gpt-5.6-luna at medium effort.');
}
if (example.update?.maxReviewAttempts !== 5) errors.push('Review attempt limit must default to five.');
if (example.creation?.routes?.private_public !== 'draft' ||
    ['public_private', 'public_public', 'private_private'].some(key => example.creation?.routes?.[key] !== 'issue')) {
  errors.push('Default creation visibility matrix is invalid.');
}
if ('statusValues' in example) errors.push('Kanban statuses must be discovered, not hard-coded.');
if ([readme, configuration, workflow, development].some(document => /[\u3400-\u9fff]/u.test(document))) {
  errors.push('README and docs must remain in English.');
}
if (!releaseWorkflow.includes('workflow_run:') ||
    !releaseWorkflow.includes("github.event.workflow_run.conclusion == 'success'") ||
    !releaseWorkflow.includes('github.event.workflow_run.head_sha')) {
  errors.push('Release must be gated by a successful online CI run for the exact commit.');
}

const requiredFiles = [
  'prompts/update.md',
  'prompts/review.md',
  'docs/configuration.md',
  'docs/workflow.md',
  'docs/development.md',
  'LICENSE',
  'scripts/mineprogress.mjs',
  'scripts/hook.mjs',
  'scripts/lib/errors.mjs',
  'scripts/lib/auth.mjs',
  'scripts/lib/state.mjs'
];
for (const relative of requiredFiles) {
  try { await fs.access(path.join(root, relative)); } catch { errors.push(`Required file is missing: ${relative}`); }
}

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else files.push(absolute);
  }
  return files;
}

for (const file of await sourceFiles(root)) {
  const content = await fs.readFile(file, 'utf8').catch(() => '');
  if (/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(content) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    errors.push(`Possible committed credential in ${path.relative(root, file)}.`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`validation: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Validated Mineprogress ${manifest.version}.`);
}
