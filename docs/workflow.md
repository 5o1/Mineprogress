# Workflow

## Thread lifecycle

Lifecycle hooks stay silent before initialization and in threads with no bound items. An explicit
Mineprogress command is the only exception, allowing initialization or the first binding. Once a
binding exists, stable user and assistant turn fields form an incremental journal. SessionEnd retains
state for a later resume. No hook queries GitHub, and no runtime file is written to the repository:

- `threads/<session-hash>.json`: bindings, journal, successful checkpoint, and recoverable update.
- `cache/project-metadata.json`: Project-wide statuses and visibility route shared by all threads.
- `logs/errors.jsonl`: sanitized append-only error and resolution events.

## Command boundary

Codex exposes one explicit Skill per operation: `$mineprogress:init`, `$mineprogress:create`,
`$mineprogress:bind`, `$mineprogress:unbind`, `$mineprogress:update`, `$mineprogress:check`, and
`$mineprogress:status`. The plugin does not register a custom slash command. Creation binds its new
item immediately. `check` returns `suggestedAdd` and `suggestedRemove` but never changes the candidate
list. Mutating commands consume a short-lived authorization recorded by UserPromptSubmit, so the CLI
cannot create or change bindings on an unrelated turn. Control commands are excluded from later
update content.

## Automatic update

Stop incrementally maintains one reviewed but unsubmitted plan:

1. Select only the journal after the last planning checkpoint and the previously approved plan.
2. Generate one consolidated replacement plan, then locally check fields, bound IDs, actual
   statuses, size, and obvious personal information.
3. Ask an independent reviewer subagent to detect context dumping, irrelevant expansion, static
   failures, unsupported claims, and author-identifying data.
4. Store the approved plan without writing GitHub. A rejection regenerates it, up to five rounds.

`SessionEnd` performs no model work. It records an attempt and submits the latest reviewed plan as
one batched GraphQL mutation, but treats the result as unverified and never removes the queue entry.
On resume, Mineprogress reads the actual Project fields: target values confirm success, unchanged
baseline values are safe to retry, and any third value is an external-edit conflict that is not
overwritten. Only complete read-back confirmation removes the plan and advances the submission
checkpoint. Manual `$mineprogress:update` submits and verifies immediately.

An approved no-op advances only the planning checkpoint. Token, permission, network, configuration,
model, or subagent failures stop immediately without consuming a content retry. An explicit sandbox
denial requests one elevated retry when an interactive command can request it.

After five rejected rounds, automatic processing remains suspended and the checkpoint stays put.
Only an explicit user-requested `update retry` starts a fresh run over that same pending journal.

## Error state

`status` folds JSONL locally, reports whether a reviewed submission is ready or unverified, and
returns at most 20 unresolved summaries for the current thread. It does not query GitHub or expose
the complete log, stack traces, tokens, personal paths, or journal.
`status resolve <errorId>` appends a resolution event without rewriting history.

Ended thread caches are retained for 30 days to support resume, then pruned from `PLUGIN_DATA` on a
later SessionStart. `MINEPROGRESS_STATE_RETENTION_DAYS` changes that retention window.
