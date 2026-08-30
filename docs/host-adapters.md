# Host Adapter Contract

Each host has `platforms/<id>/adapter.json`, validated against the versioned shape in
`platforms/adapter.schema.json`. `status: implemented` requires real command and lifecycle
entrypoints. A future integration stays `planned` until its conformance tests pass.

## Required translations

An adapter must:

1. Provide a private writable data directory outside user repositories.
2. Normalize host lifecycle input to `session-start`, `user-prompt`, `turn-stop`, or `session-end`.
   Events use `sessionId`, optional `turnId`, `prompt`, `assistantMessage`, `stopActive`, and a
   normalized `commandAction`; raw host field names must not cross the adapter boundary.
3. Convert explicit user commands into `{ command, positional, options }` and preserve the backend's
   short-lived authorization rules for mutating operations.
4. Supply a GitHub client provider. Authentication discovery and sandbox/elevation behavior belong
   to the adapter; GitHub Projects queries and mutations belong to the backend.
5. Implement isolated structured model calls and full-thread history when those capabilities are
   declared. Generated output must still pass backend validation and review.
6. Schedule background planning without blocking foreground turns, and retain queues until remote
   writes are verified.

## Adding a host

Copy a planned manifest, add code under `src/frontends/<id>/`, and declare only capabilities the host
actually supports. Add fixtures for raw-to-normalized lifecycle mapping, data-directory isolation,
explicit command authorization, model JSON output, shutdown submission, and resume reconciliation.
Do not change backend modules to accept host-specific fields. Promote the manifest to `implemented`
only after all entrypoints exist and `npm run ci` passes.

Claude Code and OpenClaw currently have contract manifests only; no runtime support is claimed.
