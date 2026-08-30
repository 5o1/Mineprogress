import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePrimaryRepository,
  primaryRepositoryFromLinks,
  upsertRepositoryReference
} from '../src/backend/repository-reference.mjs';

const proposal = `Manual prefix.
<!-- mineprogress:managed:start -->
## Abstract

A managed proposal.

## Background and Significance

Background.
<!-- mineprogress:managed:end -->
Manual suffix.`;

test('primary repository metadata defaults to a stable English description', () => {
  assert.deepEqual(primaryRepositoryFromLinks([
    'https://github.com/octocat/example.git',
    'https://example.test/ignored'
  ], 'Parser research'), {
    url: 'https://github.com/octocat/example.git',
    description: 'Primary source repository for Parser research.'
  });
  assert.equal(normalizePrimaryRepository(null), null);
});

test('repository reference is inserted at the controlled proposal location', () => {
  const updated = upsertRepositoryReference(proposal, {
    url: 'https://github.com/octocat/example',
    description: 'Primary implementation and documentation repository.'
  });
  assert.match(updated, /## Abstract[\s\S]*## Repository[\s\S]*## Background and Significance/u);
  assert.match(updated, /\[octocat\/example\]\(https:\/\/github\.com\/octocat\/example\) — Primary implementation/u);
  assert.ok(updated.startsWith('Manual prefix.'));
  assert.ok(updated.endsWith('Manual suffix.'));
});

test('repository reference replaces only its existing managed section', () => {
  const once = upsertRepositoryReference(proposal, {
    url: 'https://github.com/octocat/example',
    description: 'Old description.'
  });
  const twice = upsertRepositoryReference(once, {
    url: 'https://github.com/octocat/example',
    description: 'Updated description.'
  });
  assert.equal((twice.match(/^## Repository$/gmu) || []).length, 1);
  assert.doesNotMatch(twice, /Old description/u);
  assert.match(twice, /Updated description/u);
  assert.throws(() => upsertRepositoryReference('Unmanaged body.', {
    url: 'https://github.com/octocat/example'
  }), { code: 'REPOSITORY_REFERENCE_BODY_UNMANAGED' });
});
