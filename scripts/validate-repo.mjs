#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateHostManifest } from '../src/host/contract.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = relative => fs.readFile(path.join(root, relative), 'utf8');
const errors = [];
const hostIds = ['codex', 'claude-code', 'openclaw'];

const skillNames = ['init', 'create', 'bind', 'unbind', 'update', 'check', 'status'];
const [manifest, packageJson, hooks, example, readme, configuration, workflow, development, releaseWorkflow, releaseValidation, skillEntries] = await Promise.all([
  read('.codex-plugin/plugin.json').then(JSON.parse),
  read('package.json').then(JSON.parse),
  read('hooks/hooks.json').then(JSON.parse),
  read('config.example.json').then(JSON.parse),
  read('README.md'),
  read('docs/configuration.md'),
  read('docs/workflow.md'),
  read('docs/development.md'),
  read('.github/workflows/release.yml'),
  read('scripts/validate-release.mjs'),
  Promise.all(skillNames.map(async name => ({
    name,
    skill: await read(`skills/${name}/SKILL.md`),
    agent: await read(`skills/${name}/agents/openai.yaml`)
  })))
]);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) errors.push('Manifest version is not strict semver.');
if (manifest.version !== packageJson.version) errors.push('Manifest and package versions differ.');
if (manifest.name !== packageJson.name) errors.push('Manifest and package names differ.');
let discoveryCharacters = 0;
for (const { name, skill, agent } of skillEntries) {
  if (!skill.startsWith('---\n') || !skill.includes(`\nname: ${name}\n`)) errors.push(`Skill ${name} has invalid frontmatter.`);
  const description = skill.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
  discoveryCharacters += name.length + description.length;
  if (!description || description.length > 160) errors.push(`Skill ${name} description must be concise.`);
  if (skill.split(/\s+/u).filter(Boolean).length > 300) errors.push(`Skill ${name} body exceeds the prompt budget.`);
  if (!agent.includes('allow_implicit_invocation: false')) errors.push(`Skill ${name} must require explicit invocation.`);
  if (!agent.includes(`$mineprogress:${name}`)) errors.push(`Skill ${name} UI prompt must use its qualified command.`);
}
if (discoveryCharacters > 900) errors.push('Command Skill discovery metadata exceeds the prompt budget.');
if (manifest.interface?.defaultPrompt?.includes('$mineprogress:init') !== true) errors.push('Plugin default prompt must use a qualified command Skill.');
if (!hooks.hooks?.SessionStart || !hooks.hooks?.UserPromptSubmit || !hooks.hooks?.Stop || !hooks.hooks?.SessionEnd) {
  errors.push('Required lifecycle hooks are missing.');
}
if (!hooks.hooks?.Stop?.[0]?.hooks?.some(hook => hook.async === true && hook.command.includes('background-update.mjs'))) {
  errors.push('Stop planning must run as a separate asynchronous hook.');
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
if (typeof example.creation?.repository !== 'string' || 'defaultRepository' in example) {
  errors.push('Example config must use creation.repository rather than legacy defaultRepository.');
}
if ('statusValues' in example) errors.push('Kanban statuses must be discovered, not hard-coded.');
if ([readme, configuration, workflow, development].some(document => /[\u3400-\u9fff]/u.test(document))) {
  errors.push('README and docs must remain in English.');
}
const changelog = await read('CHANGELOG.md');
if (!/^## \[Unreleased\]$/m.test(changelog)) errors.push('CHANGELOG.md must retain an Unreleased section.');
for (const id of hostIds) {
  const adapter = await read(`platforms/${id}/adapter.json`).then(JSON.parse);
  for (const error of validateHostManifest(adapter)) errors.push(`Host adapter ${id}: ${error}.`);
  if (adapter.id !== id) errors.push(`Host adapter directory ${id} does not match manifest id.`);
  if (adapter.status === 'planned' && adapter.entrypoints) errors.push(`Planned host adapter ${id} must not claim entrypoints.`);
}
if (!releaseWorkflow.includes('workflow_run:') ||
    !releaseWorkflow.includes("github.event.workflow_run.conclusion == 'success'") ||
    !releaseWorkflow.includes('github.event.workflow_run.head_sha') ||
    !releaseWorkflow.includes("startsWith(github.event.workflow_run.head_commit.message, 'chore: bump to v')") ||
    !releaseWorkflow.includes('Require successful parent CI') ||
    !releaseWorkflow.includes('--commit "$parent_sha"') ||
    !releaseValidation.includes('chore: bump to v${version}') ||
    !releaseValidation.includes("['.codex-plugin/plugin.json', 'package.json']")) {
  errors.push('Release must be gated by a successful online CI run for the exact commit.');
}

const requiredFiles = [
  'prompts/create.md',
  'prompts/bind.md',
  'prompts/update.md',
  'prompts/review.md',
  'prompts/review-checklist.md',
  'prompts/content-metadata.md',
  'docs/configuration.md',
  'docs/workflow.md',
  'docs/development.md',
  'docs/architecture.md',
  'docs/host-adapters.md',
  'CHANGELOG.md',
  'LICENSE',
  'scripts/mineprogress.mjs',
  'scripts/background-update.mjs',
  'scripts/hook.mjs',
  'scripts/lib/atomic-file.mjs',
  'scripts/lib/errors.mjs',
  'scripts/lib/auth.mjs',
  'scripts/lib/state.mjs',
  'src/backend/application.mjs',
  'src/backend/calendar.mjs',
  'src/backend/index.mjs',
  'src/backend/lifecycle.mjs',
  'src/backend/language.mjs',
  'src/backend/references.mjs',
  'src/backend/repository-reference.mjs',
  'src/host/contract.mjs',
  'src/frontends/codex/cli.mjs',
  'src/frontends/codex/workspace-references.mjs',
  'platforms/adapter.schema.json'
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
