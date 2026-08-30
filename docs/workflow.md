# Workflow

## Thread lifecycle

The behavior below is shared backend policy; lifecycle names and thread-history details describe the
current Codex adapter. Other hosts must translate their events through the documented adapter
contract.

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
list. Before suggesting changes, it refreshes remote Project statuses and synchronizes the plugin's
private default, terminal, and semantic-role configuration. A changed status set triggers bounded
rule generation; the script stores rules only after validating exact names and reachability, while
`status` renders the cached policy without network access. Mutating commands consume a short-lived
authorization recorded by UserPromptSubmit, so the CLI
cannot create or change bindings on an unrelated turn. Control commands are excluded from later
update content. Before recording the first prompt on a later local calendar date,
UserPromptSubmit submits and verifies any reviewed pending plan. A confirmed daily submission is
recorded once for that date; failures keep the queue and date checkpoint unchanged.

Every binding stores its own content-language tag. Create and bind default it to English; only an
explicit `--language <tag>` changes that item. The backend also extracts external links from each
new journal window, while the Codex adapter contributes the current workspace remote. Generators
use the language marker directly and cite only links materially related to the bound item. The
workspace remote is also stored as structured `primaryRepository` binding metadata.

Plain `unbind` changes only the thread candidate list. Explicit `unbind --delete` closes linked
Issue content, deletes the Project item, and then removes the local binding. Status updates also
close Issues on configured terminal statuses and reopen them on non-terminal statuses. Archiving a
Project item does not change Issue state.

## Automatic update

Stop first persists the turn with a small local command, then launches a separate asynchronous Hook.
It returns control without a continuation prompt or foreground model call. The background worker
incrementally maintains one reviewed but unsubmitted plan:

1. For each new binding, fork the current Codex session ephemerally so messages from before plugin
   installation or binding are available without parsing the unstable transcript file format.
   Later passes select only the journal after the last planning checkpoint and the approved plan.
2. Generate one consolidated replacement plan, then locally check fields, bound IDs, actual
   statuses, size, proposal structure, locked Issue bodies, exact-prefix Draft appends, dated
   progress entries, personal information, and exclusion of generator/reviewer control metadata.
   An incremental replacement must retain every queued field and pending append until GitHub
   confirms the prior plan.
3. Launch a separate ephemeral Codex reviewer process to detect context dumping, irrelevant
   expansion, static failures, unsupported claims, and author-identifying data. Its checklist is a
   separate runtime file rather than part of global Skill discovery.
4. Store the approved plan without writing GitHub. A rejection regenerates it, up to five rounds.

Each run claims the exact sequence numbers currently awaiting processing and persists a recoverable
state machine: `claimed` -> `prepared` -> `staged` -> `reviewed`. The reviewer must classify every
claimed sequence exactly once as included, irrelevant, or missing. Even an unchanged plan follows
the normal review path; it can advance only when every new event is explicitly found irrelevant.
New journal events arriving during a run remain outside its fixed batch and are processed by the
next pass.

Five failed content rounds exhaust only that fixed batch. If later journal evidence arrives, the
worker automatically opens a fresh bounded run over the exhausted events and the new evidence,
then marks the superseded error handled. Without new evidence it remains dormant instead of looping;
manual `update retry` is an optional override rather than a recovery requirement.

UserPromptSubmit never classifies natural-language status intent. The background generator evaluates
the journal semantically from the verified per-item evidence ledger, pending reviewed evidence,
current Project fields, and generated status rules. A proposed status transition becomes a durable
intent only after independent review and static transition checks pass. Linked Issues are closed by
the resulting scripted terminal operation, and the intent is cleared only after GitHub confirms all
operations. If Project statuses changed, the worker first synchronizes configuration and generates
script-validated transition rules.

The first full-history pass loads `prompts/create.md` for newly created items or `prompts/bind.md`
for existing items. Later passes load `prompts/update.md`. These files are passed only to ephemeral
generator processes and do not enter the foreground thread's global prompt. A created item receives
one academic-style proposal covering background, problem, objectives, scope, method, deliverables,
evaluation, milestones, and risks. After GitHub confirms that proposal, an Issue body is immutable.
Meaningful later changes become dated Issue comments with Requirements and Results. Draft items do
not support comments, so their complete prior body must remain an exact byte prefix of every update.
The sole Issue-body exception is a script-owned `## Repository` section after the Abstract. The
backend inserts or replaces only that section with the primary repository link and description by
calling `updateIssue`; it never appends the link as progress. It compares the complete remote body
with the planned baseline first, so an external edit causes a conflict instead of an overwrite. The
script enforces these constraints independently of generated instructions. The Project `Update`
field remains concise.

Both the generator and independent reviewer receive full history during backfill. A successful
backfill records its own revision checkpoint; failure leaves the revision pending. The worker
disables nested hooks and plugins, serializes one worker per thread, and records failures in the
plugin error log instead of surfacing them in the foreground conversation. Every phase transition
is atomically written before the next side effect. A process interruption therefore leaves either
the previous complete state or the next complete state: preparation can restart generation, a
staged plan resumes at review, and an approved plan resumes at local queue creation without another
model call. Only the final atomic write advances the planning checkpoint, prunes the entire claimed
batch, and installs its pending submission together.

Because Codex may cancel unfinished asynchronous hooks on exit, both `startup` and `resume`
SessionStart events launch the same serialized background worker. It detects an active run or
unverified submission and continues automatically without a user command; later Stop events are an
additional recovery opportunity. The plugin treats `transcript_path` as opaque because Codex does
not guarantee its on-disk format.

`SessionEnd` performs no model work. It records an attempt and submits the latest reviewed plan as
one batched GraphQL mutation, but treats the result as unverified and never removes the queue entry.
On resume, Mineprogress reads Project fields and content bodies, and searches paginated Issue
comments for a stable hidden operation marker. Target values confirm success, unchanged baseline
values are safe to retry, and any third value is an external-edit conflict that is not overwritten.
Only complete read-back confirmation removes the plan and advances the submission checkpoint. Resume
performs this check first; if the same process continues receiving turns after SessionEnd, the next
asynchronous Stop worker also reconciles the attempted submission before planning newer context.
Manual `$mineprogress:update` submits and verifies immediately.

That confirmation also moves reviewed plan evidence into the binding ledger. If local evidence is
absent after installation, migration, or cache recovery, preparation paginates linked Issue comments
but retains only Mineprogress-marked Requirements and Results; Draft items are recovered from the
same structured Progress Update sections. Unmanaged comments and complete logs never enter the
generator input.

An approved unchanged plan advances only the planning checkpoint after complete journal coverage.
Token, permission, network, configuration, model, or subagent failures stop immediately without
consuming a content retry. An explicit sandbox denial requests one elevated retry when an
interactive command can request it.

After five rejected rounds, automatic processing remains suspended and the checkpoint stays put.
Only an explicit user-requested `update retry` starts a fresh run over that same pending journal.

## Error state

`status` folds JSONL locally, reports the journal state-machine phase and whether a reviewed
submission is ready or unverified, and returns at most 20 unresolved summaries for the current
thread. It does not query GitHub or expose the complete log, stack traces, tokens, personal paths,
or journal.
`status resolve <errorId>` appends a resolution event without rewriting history.

Ended thread caches are retained for 30 days to support resume, then pruned from `PLUGIN_DATA` on a
later SessionStart. `MINEPROGRESS_STATE_RETENTION_DAYS` changes that retention window.
