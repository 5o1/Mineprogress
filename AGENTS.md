# Repository Guidelines

## Project Structure & Module Organization

Mineprogress is a dependency-free Node.js Codex plugin for thread-bound GitHub Projects Kanban work.

- `scripts/mineprogress.mjs`: command entry point for init, create, bind, update, check, and status.
- `scripts/hook.mjs`: SessionStart, UserPromptSubmit, Stop, and SessionEnd adapter.
- `scripts/lib/`: configuration, GitHub GraphQL, state, validation, metadata, and error modules.
- `hooks/hooks.json` and `skills/<command>/SKILL.md`: lifecycle hooks and command-specific Skills.
- `prompts/`: update and reviewer output contracts.
- `test/*.test.mjs`: Node test suites; `docs/` contains detailed user and maintainer guidance.
- `.github/workflows/`: focused CI and tag-based GitHub Release automation.

Runtime state belongs under Codex `PLUGIN_DATA`, never in a working repository.

## Build, Test, and Development Commands

Use Node.js 22 or newer. There is no build step or npm runtime dependency; GitHub CLI login is the
preferred authentication source, with environment tokens as fallback.

- `npm test`: run all native `node:test` suites.
- `npm run validate`: check versions, plugin structure, required resources, and committed secrets.
- `npm run ci`: run the same test and validation sequence used by GitHub Actions.
- `$mineprogress:init`: run the user-facing guided Project setup inside Codex.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, semicolons, and single quotes. Prefer small named functions
with injected network clients. Use `camelCase` for values/functions, `UPPER_SNAKE_CASE` for GraphQL
constants, and kebab-case `.mjs` filenames. Keep runtime code dependency-free unless a dependency has
a clear maintenance benefit. No formatter or linter is configured; match surrounding code.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Name files `<feature>.test.mjs`. Keep tests deterministic:
mock GraphQL responses and use temporary `PLUGIN_DATA` directories instead of live GitHub calls.
Cover new state transitions, failure classifications, and public-write routing. Run `npm run ci`
before submitting; no numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

History uses short Conventional Commit subjects such as `feat: add guided project setup`. Keep
commits focused. Pull requests should explain behavior and
configuration changes, link relevant issues, and include `npm run ci` results. Include output or
screenshots only when user-visible rendering changes.

## Security & Release

Never commit tokens, plugin cache, Project content, or personal paths. Keep GitHub permissions
minimal. Manifest and package versions must match; a `v<version>` tag triggers the release workflow.
