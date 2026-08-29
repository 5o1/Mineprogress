# Workflow

## Thread lifecycle

SessionStart only creates or restores cache under Codex's `PLUGIN_DATA`; it does not query GitHub.
Stable user and assistant turn fields form an incremental journal. SessionEnd retains state for a
later resume. No runtime file is written to the working repository:

- `threads/<session-hash>.json`: bindings, journal, successful checkpoint, and recoverable update.
- `cache/project-metadata.json`: Project-wide statuses and visibility route shared by all threads.
- `logs/errors.jsonl`: sanitized append-only error and resolution events.

## Command boundary

Codex invokes Mineprogress explicitly with `$mineprogress`; the plugin does not register a custom
slash command. `create`, `bind`, and `unbind` require a current user instruction. Creation binds its
new item immediately. `check` returns `suggestedAdd` and `suggestedRemove` but never changes the
candidate list. Mutating commands consume a short-lived authorization recorded by UserPromptSubmit,
so the CLI cannot create or change bindings on an unrelated turn. Control commands are excluded from
later update content.

## Automatic update

Stop and manual `$mineprogress update` use the same workflow:

1. Select only the journal after the last successful checkpoint and currently bound items.
2. Generate a restricted JSON plan, then locally check fields, bound IDs, actual statuses, size, and
   obvious personal information.
3. Ask an independent reviewer subagent to detect context dumping, irrelevant expansion, static
   failures, unsupported claims, and author-identifying data.
4. Write to GitHub only after approval. A rejection regenerates the plan, up to five total rounds.

An approved no-op advances the checkpoint. Partial GitHub writes retain idempotent operation keys
but do not advance it. Token, permission, network, configuration, model, or subagent failures stop
immediately without consuming a content retry. An explicit sandbox denial requests one elevated
retry of the same command.

After five rejected rounds, automatic processing remains suspended and the checkpoint stays put.
Only an explicit user-requested `update retry` starts a fresh run over that same pending journal.

## Error state

`status` folds JSONL locally and returns at most 20 unresolved summaries for the current thread. It
does not query GitHub or expose the complete log, stack traces, tokens, personal paths, or journal.
`status resolve <errorId>` appends a resolution event without rewriting history.

Ended thread caches are retained for 30 days to support resume, then pruned from `PLUGIN_DATA` on a
later SessionStart. `MINEPROGRESS_STATE_RETENTION_DAYS` changes that retention window.
