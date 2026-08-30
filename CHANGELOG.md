# Changelog

Notable user-visible changes are documented here. Entries follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and use semantic versions.

## [Unreleased]

### Fixed

- Separated transient journal input from a per-item evidence ledger. Verified reviewed plans are
  folded into the ledger only after GitHub read-back, while a missing local ledger is reconstructed
  from compact Mineprogress-managed Issue comments or Draft progress sections.
- Persisted explicit completion intent until the configured terminal Project status and linked
  Issue closure are verified. Plans carry evidence and intent revisions, so an unattempted stale
  plan cannot be submitted after newer state arrives.
- Made submission attempt and response persistence reload the latest locked thread state instead of
  overwriting journal events that arrived during GitHub network I/O.
- Generate and validate missing Project status rules automatically before processing a durable
  status intent, including after remote status configuration changes.

## [0.6.0] - 2026-08-30

### Changed

- Separated host-independent application, lifecycle, persistence, validation, and GitHub Projects
  logic from Codex CLI, hook, authentication, and model-runtime adapters.
- Reduced legacy `scripts/` modules to compatibility entrypoints while preserving existing imports.
- Made `check` synchronize changed remote Project statuses into private default, terminal, and
  workflow-role configuration before producing binding suggestions. Initialization and changed
  status sets now trigger agent-generated, script-validated transition rules that constrain updates
  and are visible through `status`.

### Added

- Added a versioned host-adapter contract, capability manifests, and contributor specifications for
  future Claude Code and OpenClaw integrations without claiming runtime support.
- Added architecture tests that prevent host payload fields, command syntax, or adapter imports from
  entering backend source.

### Fixed

- Replaced eager journal checkpointing with a crash-recoverable `claimed`/`prepared`/`staged`/
  `reviewed` state machine. Every claimed journal entry now requires explicit reviewer coverage,
  checkpoints and pruning occur only in the final atomic commit, and startup/resume silently
  continues interrupted generation, review, local queue creation, or submission reconciliation.
- Preserved the legacy no-argument configuration loader at the compatibility entrypoint while
  keeping the backend API explicit.
- Reused canonical boolean-flag parsing when attributing command failures to thread-scoped logs.
- Enforced every required, typed, and closed field in host adapter manifests during validation.
- Reconciled attempted shutdown submissions from the next asynchronous Stop worker so continued
  threads do not leave newer journal entries indefinitely blocked while waiting for a resume event.
- Persisted a default-English language tag per bound item, with explicit per-item overrides, and
  rejected generated content that violates supported language markers.
- Supplied generators and reviewers with deduplicated thread reference links so durable Issue,
  pull-request, artifact, and source links are not silently omitted from relevant records.
- Stored the active workspace repository as item metadata and synchronized its link and description
  through a guarded, script-owned Issue proposal section instead of an appended progress comment.
- Submitted and verified a reviewed pending plan before recording the first user prompt on a later
  local calendar date, without repeating the automatic submission again that day.
## [0.5.0] - 2026-08-30

### Added

- Guided initialization from a GitHub Project URL, including linked-repository discovery.
- Background generation and independent review of thread-bound Kanban updates.
- Full-thread backfill for newly bound items, including conversation history from before plugin installation.
- One-time academic project proposals with recoverable, dated progress comments.
- Separate runtime contracts for create, bind, incremental updates, and reviewer checks.
- Guided detection of a configurable default Kanban status and conventional terminal statuses.
- Explicit synchronized deletion that closes linked Issues before removing Project items.

### Changed

- Renamed the persisted Issue target to `creation.repository`; legacy `defaultRepository` values
  remain readable, while initialization no longer claims linked repositories reveal GitHub's
  single default repository.
- Deferred Project submissions remain queued until GitHub read-back confirms every field update.
- Stop persists the turn locally and delegates model work to a non-blocking asynchronous Hook.
- Project summaries remain concise while Issue comments retain append-only progress history.
- Draft progress uses append-only body suffixes because GitHub Draft items do not support comments.
- Unsubmitted legacy summary plans are replaced by a full structured-history backfill after upgrade.

### Fixed

- Incremental revisions must preserve every queued item, non-null field, pending comment, and
  approved managed-history line until GitHub confirms submission.
- Generator attempts, reviewer state, static-check results, and other transient worker metadata are
  rejected before they can replace Project content.
- Incompatible unsubmitted plans are discarded locally and scheduled for full-history regeneration;
  plans with a prior submission attempt remain available for safe reconciliation.
- Empty incremental results now advance the planning checkpoint while retaining an existing queued
  plan, instead of exhausting review retries or discarding approved content.
- New items receive the configured default status, while terminal/non-terminal transitions close or
  reopen linked Issues.
- State, configuration, and metadata writes retry transient Windows rename contention, and the
  background Hook now locks its initial state read.
- Script validation and operation construction lock Issue bodies after their initial proposal,
  enforce exact-prefix Draft appends, and re-read remote bodies before mutation.
