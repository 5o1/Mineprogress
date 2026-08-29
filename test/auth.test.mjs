import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGithubToken } from '../scripts/lib/auth.mjs';

test('GitHub CLI login takes priority over environment tokens', async () => {
  const result = await resolveGithubToken({
    env: { GITHUB_TOKEN: 'environment-token' },
    execFileImpl: async (file, args) => {
      assert.equal(file, 'gh');
      assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']);
      return { stdout: 'cli-token\n' };
    }
  });
  assert.deepEqual(result, { token: 'cli-token', source: 'gh' });
});

test('environment token is a fallback when GitHub CLI login is unavailable', async () => {
  const result = await resolveGithubToken({
    env: { GH_TOKEN: 'environment-token' },
    execFileImpl: async () => { throw Object.assign(new Error('not logged in'), { code: 1 }); }
  });
  assert.deepEqual(result, { token: 'environment-token', source: 'environment' });
});

test('ambiguous logged-out result requests one sandbox elevation', async () => {
  await assert.rejects(resolveGithubToken({
    env: {},
    execFileImpl: async () => { throw Object.assign(new Error('not logged in'), { code: 1 }); }
  }), { code: 'SANDBOX_DENIED' });
});

test('elevated retry distinguishes a real missing login', async () => {
  await assert.rejects(resolveGithubToken({
    env: { MINEPROGRESS_ELEVATED_RETRY: '1' },
    execFileImpl: async () => { throw Object.assign(new Error('not logged in'), { code: 1 }); }
  }), { code: 'GH_TOKEN_MISSING' });
});

test('missing gh executable skips an unhelpful elevation request', async () => {
  await assert.rejects(resolveGithubToken({
    env: {},
    execFileImpl: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
  }), { code: 'GH_TOKEN_MISSING' });
});
