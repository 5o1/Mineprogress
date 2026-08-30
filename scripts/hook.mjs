#!/usr/bin/env node
import { main, reportHookError } from '../src/frontends/codex/hook.mjs';

export * from '../src/frontends/codex/hook.mjs';

await main().catch(reportHookError);
