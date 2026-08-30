# Development and Release

## Local verification

```text
npm test
npm run validate
npm run ci
```

Tests use Node's built-in `node:test` and cover thread isolation, incremental checkpoints, dynamic
statuses, all four visibility routes, issue-to-Project insertion, full-thread binding backfill,
managed Issue/Draft bodies, recoverable Issue comments, background planning boundaries, static
review checks, error redaction, and Stop loop prevention.
`validate` checks manifest/package versions, hook paths,
command-Skill discovery size, explicit invocation policy, and required resources.

## GitHub Actions

`.github/workflows/ci.yml` runs `npm run ci` on main pushes, pull requests, and manual dispatch with
Node 24.

`.github/workflows/release.yml` starts only after the online `CI` workflow completes successfully on
main. A feature or fix commit never changes version files or receives a release tag. Stability and a
successful online CI are necessary but do not authorize a release: wait until the repository owner
explicitly requests a version bump. First convert the relevant `Unreleased` notes in `CHANGELOG.md`
into a dated `## [X.Y.Z] - YYYY-MM-DD` entry with categorized, user-visible changes, commit it
separately, and require successful CI. Only then create a separate commit whose subject is exactly
`chore: bump to vX.Y.Z`; it may change only the `version` fields in `.codex-plugin/plugin.json` and
`package.json`.

Tag that bump commit as `vX.Y.Z` and push main plus the annotated tag atomically. Release requires
successful online CI for both the parent implementation commit and the bump commit, verifies the
isolated diff and exact subject, then builds the archive. Missing or mismatched tags skip publication;
policy violations fail before any asset is published.
The release validator also rejects a missing, placeholder, or uncategorized target-version changelog.
