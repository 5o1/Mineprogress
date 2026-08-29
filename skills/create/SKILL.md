---
name: create
description: Create and bind a user-requested Mineprogress Kanban item using the configured visibility route.
---

# Create a Kanban Item

Read [the shared runtime contract](../.shared/runtime.md). Act only on the title explicitly supplied
in the current user invocation. Run `node <plugin-root>/scripts/mineprogress.mjs settings --data-dir
<data_dir>`, use the configured create model only to normalize that title without adding intent,
then run:

```text
node <plugin-root>/scripts/mineprogress.mjs create --title <title> --session <session_id> --data-dir <data_dir>
```

The CLI selects a repository issue or Project draft from the configured visibility route and binds
the resulting Project item immediately. Do not create additional items or infer a title from earlier
conversation.
