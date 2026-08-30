#!/usr/bin/env node
import { main, reportHookError } from '../src/frontends/codex/hook.mjs';
import process from 'node:process';
import { reexecWithEnvironmentProxy } from '../src/frontends/codex/env-proxy.mjs';

export * from '../src/frontends/codex/hook.mjs';

const proxyExitCode = await reexecWithEnvironmentProxy().catch(reportHookError);
if (proxyExitCode === null) await main().catch(reportHookError);
else if (Number.isInteger(proxyExitCode)) process.exitCode = proxyExitCode;
