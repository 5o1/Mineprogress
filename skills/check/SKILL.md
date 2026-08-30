---
name: check
description: Compare current thread bindings with the configured Project and suggest binding changes without applying them.
---

# Check Candidate Bindings

Read [the shared runtime contract](../.shared/runtime.md), then run:

```text
node <plugin-root>/scripts/mineprogress.mjs check --session <session_id> --data-dir <data_dir>
```

Show `suggestedAdd` and `suggestedRemove`, and report the discovered statuses plus the configured
default and terminal statuses. This command is
read-only: never bind or unbind an item, and never advance the update checkpoint.
