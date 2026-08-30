#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/frontends/codex/cli.mjs';

export * from '../src/frontends/codex/cli.mjs';

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) await main();
