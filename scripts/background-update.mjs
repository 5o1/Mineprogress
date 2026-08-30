#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/frontends/codex/background-update.mjs';
import { reexecWithEnvironmentProxy } from '../src/frontends/codex/env-proxy.mjs';

export * from '../src/frontends/codex/background-update.mjs';

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) {
  const proxyExitCode = await reexecWithEnvironmentProxy();
  if (proxyExitCode === null) await main();
  else process.exitCode = proxyExitCode;
}
