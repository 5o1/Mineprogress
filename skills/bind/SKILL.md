---
name: bind
description: Bind one explicit GitHub Project item to the current Codex thread.
---

# Bind a Project Item

Read [the shared runtime contract](../.shared/runtime.md). Require an item ID in the current user
invocation, then run:

```text
node <plugin-root>/scripts/mineprogress.mjs bind <itemId> --session <session_id> --data-dir <data_dir>
```

Report whether the item was newly bound or already present. Never bind suggestions from `check`
without a separate explicit user invocation.
