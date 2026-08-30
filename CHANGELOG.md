# Changelog

Notable user-visible changes are documented here. Entries follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and use semantic versions.

## [Unreleased]

### Added

- Guided initialization from a GitHub Project URL, including linked-repository discovery.
- Background generation and independent review of thread-bound Kanban updates.
- Full-thread backfill for newly bound items, including conversation history from before plugin installation.
- Managed Issue and Draft bodies with chronological Requirements/Results history and recoverable Issue comments.
- Separate runtime contracts for create, bind, incremental updates, and reviewer checks.
- Guided detection of a configurable default Kanban status and conventional terminal statuses.
- Explicit synchronized deletion that closes linked Issues before removing Project items.

### Changed

- Deferred Project submissions remain queued until GitHub read-back confirms every field update.
- Stop persists the turn locally and delegates model work to a non-blocking asynchronous Hook.
- Project summaries remain concise while detailed progress is maintained in the item's body.
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
