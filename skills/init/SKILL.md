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

The CLI uses the Project's sole linked repository, creates a missing `Update` text field, and saves
configuration immediately. On `initialized`, report the Project, repository, visibility, creation
route, available statuses, detected default and terminal statuses, and whether the field was
created. Do not ask for confirmation.

If it returns `repository_selection_required`, present only its repository candidates and ask the
user to choose one. Rerun init with `--repository <owner/name>`, or use `--no-repository` only when
the user explicitly chooses draft-only creation. For any error, give the returned corrective action
without exposing logs or credentials. Never invent or replace a missing Status field.
