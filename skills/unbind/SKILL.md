---
name: unbind
description: Remove one explicit GitHub Project item from the current Codex thread candidate list.
---

# Unbind a Project Item

Read [the shared runtime contract](../.shared/runtime.md). Require an item ID in the current user
invocation, then run:

```text
node <plugin-root>/scripts/mineprogress.mjs unbind <itemId> --session <session_id> --data-dir <data_dir>
```

Report whether the binding was removed. Do not remove bindings merely because `check` recommends
it; that recommendation still requires this explicit command.

Plain unbind changes only the current thread. If and only if the user explicitly asks to delete the
Project item, add `--delete`. That path closes linked Issue content first, deletes the Project item,
then removes the local binding. Never infer deletion from an unbind request.
