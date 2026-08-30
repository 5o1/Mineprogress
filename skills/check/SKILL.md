---
name: check
description: Synchronize Project statuses and rules, then compare thread bindings and suggest changes without applying them.
---

# Check Candidate Bindings

Read [the shared runtime contract](../.shared/runtime.md), then run:

```text
node <plugin-root>/scripts/mineprogress.mjs check --session <session_id> --data-dir <data_dir>
```

Show `configurationChanges`, `statusRoles`, `suggestedAdd`, and `suggestedRemove`, then report the
fresh statuses plus the synchronized default and terminal statuses. The command may update the
plugin's private configuration and metadata cache, but it is read-only toward GitHub: never bind or
unbind an item, mutate the Project, or advance the update checkpoint.

If `statusRuleGeneration.required` is true, read `prompts/status-rules.md`, generate only its JSON
object from `statusRuleGeneration`, save it in a private temporary file, and rerun `check` with
`--rules-file <file>`. Delete the temporary file afterward. Report a validation error instead of
weakening or bypassing the rule contract.
