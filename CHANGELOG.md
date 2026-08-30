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

### Changed

- Deferred Project submissions remain queued until GitHub read-back confirms every field update.
- Stop persists the turn locally and delegates model work to a non-blocking asynchronous Hook.
- Project summaries remain concise while detailed progress is maintained in the item's body.
- Unsubmitted legacy summary plans are replaced by a full structured-history backfill after upgrade.
