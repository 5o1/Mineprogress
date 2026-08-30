# Changelog

Notable user-visible changes are documented here. Entries follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and use semantic versions.

## [Unreleased]

### Added

- Guided initialization from a GitHub Project URL, including linked-repository discovery.
- Background generation and independent review of thread-bound Kanban updates.
- Full-thread backfill for newly bound items, including conversation history from before plugin installation.

### Changed

- Deferred Project submissions remain queued until GitHub read-back confirms every field update.
- Stop persists the turn locally and delegates model work to a non-blocking asynchronous Hook.
