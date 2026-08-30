# Architecture

Mineprogress separates the product backend from coding-agent hosts. A frontend is a replaceable
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

## Durable update state

Thread state is one atomically replaced JSON document. An update claims an immutable set of journal
sequence numbers and moves through `claimed`, `prepared`, `staged`, and `reviewed`. The journal,
planning checkpoint, active run, and pending submission are committed together, so a process exit
cannot expose a checkpoint whose source events were not retained or reviewed. Host adapters should
resume this state machine automatically at session startup and serialize workers per thread.

GitHub submission is a separate recoverable transaction. Mineprogress persists an unverified
attempt before network I/O, reconciles remote values and stable operation markers after restart,
and clears the queue only after complete read-back confirmation. Each pending plan records the
per-item evidence and status-intent revisions from which it was generated; an unattempted stale plan
is regenerated rather than submitted.

Each binding also owns a compact evidence ledger and a monotonic status-intent revision. Journal
text is transient: after review, only sanitized plan fields become pending evidence, while the
processed-journal audit retains hashes and classifications. Verified submission folds pending
evidence into the ledger. A fresh or migrated cache reconstructs missing evidence only from
Mineprogress-marked Issue comments or structured Draft progress sections.

Prompt files are backend resources selected by use cases, while model invocation remains an adapter
capability. This keeps generation policy shared without coupling the backend to one model runner.
