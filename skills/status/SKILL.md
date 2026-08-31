---
name: status
description: Show Mineprogress creation routing, cached Kanban statuses, bindings, and unresolved errors without querying GitHub.
---

# Show Mineprogress Status

Read [the shared runtime contract](../.shared/runtime.md), then run:

```text
node <plugin-root>/scripts/mineprogress.mjs status --session <session_id> --data-dir <data_dir>
```

Show `creationPolicyLine`, `kanbanStatusLine`, and `kanbanPolicyLine` on separate lines, followed by
every `statusRules` line, `journalStateLine`, `pendingPlanLine`, and only unresolved summaries for
this session. Show `workflowBlockLine` immediately after `pendingPlanLine`. Use `status --all` only
when explicitly requested. For an explicit `resolve <errorId>`
invocation, run `status resolve <errorId>`; it appends a resolution event and never rewrites or
exposes the complete error log.
