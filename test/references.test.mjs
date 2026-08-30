import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReferenceLinks, mergeReferenceLinks } from '../src/backend/references.mjs';
import {
  discoverWorkspaceReferences,
  normalizeGitRemote
} from '../src/frontends/codex/workspace-references.mjs';

test('journal reference extraction deduplicates links and removes fragments', () => {
  const links = extractReferenceLinks([
    { text: 'Repository: https://github.com/5o1/Mineprogress.git' },
    { text: 'Issue: https://github.com/5o1/Mineprogress/issues/3#discussion.' },
    { text: 'Repository again: https://github.com/5o1/Mineprogress.git' }
  ]);
  assert.deepEqual(links, [
    'https://github.com/5o1/Mineprogress.git',
    'https://github.com/5o1/Mineprogress/issues/3'
  ]);
  assert.deepEqual(mergeReferenceLinks(links, ['https://github.com/5o1/Mineprogress.git']), links);
});

test('Codex workspace reference discovery normalizes common Git remote forms', async () => {
  assert.equal(normalizeGitRemote('git@github.com:5o1/Mineprogress.git'), 'https://github.com/5o1/Mineprogress');
  assert.equal(normalizeGitRemote('https://github.com/5o1/Mineprogress.git'), 'https://github.com/5o1/Mineprogress');
  const references = await discoverWorkspaceReferences({
    cwd: '.',
    execFileImpl: async () => ({ stdout: 'git@github.com:5o1/Mineprogress.git\n' })
  });
  assert.deepEqual(references, ['https://github.com/5o1/Mineprogress']);
});
