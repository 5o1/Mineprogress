# Workflow

## Thread lifecycle

Lifecycle hooks stay silent and create no thread state before initialization or in ordinary threads
with no bound item. A first `create` or `bind` marks the binding for full-history backfill. SessionEnd
retains state for a later resume, and no runtime file is written to the repository:

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

Stop first persists the turn with a small local command, then launches a separate asynchronous Hook.
It returns control without a continuation prompt or foreground model call. The background worker
incrementally maintains one reviewed but unsubmitted plan:

1. For each new binding, fork the current Codex session ephemerally so messages from before plugin
   installation or binding are available without parsing the unstable transcript file format.
   Later passes select only the journal after the last planning checkpoint and the approved plan.
2. Generate one consolidated replacement plan, then locally check fields, bound IDs, actual
   statuses, size, managed-body structure, chronological history, preservation of manual body text,
   and obvious personal information.
3. Launch a separate ephemeral Codex reviewer process to detect context dumping, irrelevant
   expansion, static failures, unsupported claims, and author-identifying data. Its checklist is a
   separate runtime file rather than part of global Skill discovery.
4. Store the approved plan without writing GitHub. A rejection regenerates it, up to five rounds.

The first full-history pass loads `prompts/create.md` for newly created items or `prompts/bind.md`
for existing items. Later passes load `prompts/update.md`. These files are passed only to ephemeral
generator processes and do not enter the foreground thread's global prompt. An Issue or Draft body
contains a managed `Historical Progress` section with chronological dated segments; every segment
separates Requirements from Results. Text outside the managed markers is preserved exactly. The
Project `Update` field remains concise. A repository Issue receives a comment only for a meaningful
new result or status transition; initial backfills, ordinary Q&A, and Draft items do not.

Both the generator and independent reviewer receive full history during backfill. A successful
backfill records its own revision checkpoint; failure leaves the revision pending for another Stop.
The worker disables nested hooks and plugins, serializes one worker per thread, and records failures
in the plugin error log instead of surfacing them in the foreground conversation. Because Codex may
cancel unfinished asynchronous hooks on exit, the journal, active run, and pending plan remain
durable; a later Stop resumes them rather than discarding context. The plugin treats
`transcript_path` as opaque because Codex does not guarantee its on-disk format.

`SessionEnd` performs no model work. It records an attempt and submits the latest reviewed plan as
one batched GraphQL mutation, but treats the result as unverified and never removes the queue entry.
On resume, Mineprogress reads Project fields and content bodies, and searches paginated Issue
comments for a stable hidden operation marker. Target values confirm success, unchanged baseline
values are safe to retry, and any third value is an external-edit conflict that is not overwritten.
Only complete read-back confirmation removes the plan and advances the submission checkpoint.
Manual `$mineprogress:update` submits and verifies immediately.

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
