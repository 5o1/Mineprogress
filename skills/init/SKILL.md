---
name: init
description: Initialize Mineprogress directly from a GitHub Project URL and report the resulting configuration.
---

# Initialize Mineprogress

Read [the shared runtime contract](../.shared/runtime.md), then ask only for a GitHub Project URL.

Run:

```text
node <plugin-root>/scripts/mineprogress.mjs init --project-url <url> --data-dir <data_dir>
```

The GitHub public API lists linked repositories but does not identify the Project's single default
repository. The CLI may use a sole linked repository as Mineprogress's Issue repository, creates a
missing `Update` text field, and saves configuration immediately. On `initialized`, report the
Project, Issue repository and its selection source, visibility, creation route, statuses, and field
creation result. Do not call the Issue repository the GitHub default.

On successful initialization, if `statusRuleGeneration.required` is true, read
`prompts/status-rules.md`, generate only its JSON object from `statusRuleGeneration`, save it in a
private temporary file, and run `check --rules-file <file>` with the same session and data directory.
Delete the temporary file afterward. Initialization is complete only after those rules pass script
validation and are stored.

If it returns `repository_selection_required`, explain the API limitation, present only its linked
repository candidates, and ask which repository Mineprogress should use for Issues. Rerun init with
`--repository <owner/name>`, or use `--no-repository` only when the user explicitly chooses
draft-only creation. For any error, give the returned corrective action without exposing logs or
credentials. Never invent or replace a missing Status field.
