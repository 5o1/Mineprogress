# Architecture

Mineprogress separates the product backend from coding-agent hosts. “Frontend” means a replaceable
host adapter, not a graphical interface.

## Dependency direction

`src/backend/` owns use cases, state transitions, persistence, validation, error records, and GitHub
Projects GraphQL I/O. It receives a runtime object containing `dataDir`, `resourceRoot`,
`environment`, `sessionId`, and an asynchronous `githubClient` provider. It does not read Codex hook
payloads, invoke a host model, or know command syntax.

`src/host/contract.mjs` defines normalized lifecycle events and validates adapter manifests.
`src/frontends/codex/` translates Codex input into that contract and supplies GitHub authentication,
thread-history model calls, background execution, CLI output, and elevation signals. Root `scripts/`
files are intentionally thin compatibility entrypoints; root `hooks/` and `skills/` are Codex package
resources.

The dependency direction is always:

```text
host resources -> host adapter -> host contract -> backend -> GitHub API
```

The backend must never import a host adapter. `test/architecture.test.mjs` enforces this boundary.

## Backend API

Adapters import the public surface from `src/backend/index.mjs` and call
`executeBackend({ command, positional, options }, runtime)`. CLI-like integrations may use
`runBackend(argv, runtime)`. Lifecycle
adapters call the handlers in `src/backend/lifecycle.mjs` with normalized events. Submission recovery
is exposed separately through `reconcilePendingUpdate` and `submitPendingUpdate`.

Prompt files are backend resources selected by use cases, while model invocation remains an adapter
capability. This keeps generation policy shared without coupling the backend to one model runner.
