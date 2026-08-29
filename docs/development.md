# Development and Release

## Local verification

```text
npm test
npm run validate
npm run ci
```

Tests use Node's built-in `node:test` and cover thread isolation, incremental checkpoints, dynamic
statuses, all four visibility routes, issue-to-Project insertion, static review checks, error
redaction, and Stop loop prevention. `validate` checks manifest/package versions, hook paths, the
explicit Skill policy, and required resources.

## GitHub Actions

`.github/workflows/ci.yml` runs `npm run ci` on main pushes, pull requests, and manual dispatch with
Node 24.

`.github/workflows/release.yml` runs only for `v*` tags with minimal `contents: write` permission. It
repeats verification, requires the tag to exactly match the manifest/package version, builds a
source archive with `git archive`, and uses GitHub CLI to create or update the matching Release.

Advance semver when a version is ready for formal release. For example, manifest and package version
`0.2.1` require tag `v0.2.1`.
