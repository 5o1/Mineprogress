import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { reexecWithEnvironmentProxy } from '../src/frontends/codex/env-proxy.mjs';

test('Codex entrypoints re-exec once with Node environment proxy support', async () => {
  const calls = [];
  const exitCode = await reexecWithEnvironmentProxy({
    env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
    argv: ['node', 'scripts/hook.mjs', 'session-start'],
    execArgv: ['--trace-warnings'],
    execPath: 'node',
    allowedFlags: new Set(['--use-env-proxy']),
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    }
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls[0].args, [
    '--use-env-proxy', '--trace-warnings', 'scripts/hook.mjs', 'session-start'
  ]);
  assert.equal(calls[0].options.env.MINEPROGRESS_ENV_PROXY_ACTIVE, '1');
  assert.equal(calls[0].options.windowsHide, true);
});

test('proxy bootstrap is skipped without proxy support or after re-exec', async () => {
  const common = {
    argv: ['node', 'scripts/hook.mjs'], execArgv: [], execPath: 'node',
    allowedFlags: new Set(['--use-env-proxy']),
    spawnProcess: () => { throw new Error('spawn must not run'); }
  };
  assert.equal(await reexecWithEnvironmentProxy({ ...common, env: {} }), null);
  assert.equal(await reexecWithEnvironmentProxy({
    ...common, env: { HTTPS_PROXY: 'http://proxy', MINEPROGRESS_ENV_PROXY_ACTIVE: '1' }
  }), null);
  assert.equal(await reexecWithEnvironmentProxy({
    ...common, env: { HTTPS_PROXY: 'http://proxy' }, allowedFlags: new Set()
  }), null);
});
