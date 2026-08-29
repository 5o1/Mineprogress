---
name: init
description: Configure Mineprogress for a GitHub Project through preview and explicit confirmation.
---

# Initialize Mineprogress

Read [the shared runtime contract](../.shared/runtime.md), then ask only for a GitHub Project URL.

Run:

```text
node <plugin-root>/scripts/mineprogress.mjs init preview --project-url <url> --data-dir <data_dir>
```

The CLI automatically uses the Project's sole linked repository. If it returns
`repository_selection_required`, present only the returned candidates and ask the user to choose
one; rerun preview with `--repository <owner/name>`, or use `--no-repository` only when the user
explicitly chooses draft-only creation. Present the detected fields, statuses, visibility, creation
route, and whether an `Update` field would be created. Wait for explicit confirmation, then lock the
previewed choice by running `init apply --confirm` with `--repository <owner/name>` or
`--no-repository`. Never invent a missing Status field or apply without confirmation.
