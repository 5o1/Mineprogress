---
name: init
description: Configure Mineprogress for a GitHub Project through preview and explicit confirmation.
---

# Initialize Mineprogress

Read [the shared runtime contract](../.shared/runtime.md), then ask for a GitHub Project URL and an
optional default repository in `owner/name` form.

Run:

```text
node <plugin-root>/scripts/mineprogress.mjs init preview --project-url <url> --repository <owner/name> --data-dir <data_dir>
```

Omit `--repository` when none is supplied. Present the detected fields, statuses, Project and
repository visibility, creation route, and whether an `Update` field would be created. Wait for
explicit confirmation before running the same arguments with `init apply --confirm`. Never invent a
missing Status field or apply a preview without confirmation.
