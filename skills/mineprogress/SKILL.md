---
name: mineprogress
description: Manage thread-bound Kanban items in the configured GitHub Project with explicit create, bind, unbind, update, check, and status commands.
policy:
  allow_implicit_invocation: false
---

# Mineprogress

Invoke this skill only when the user explicitly uses `$mineprogress` or directly asks Codex to run a
Mineprogress command. The SessionStart context supplies `session_id` and `data_dir`. Run the plugin
CLI from this skill's plugin root and pass both values to every stateful command.

## Commands

- `init`: guide the user through setup. Ask for a GitHub Project URL and optional default repository,
  run `init preview`, present detected fields/statuses/visibility and any `Update` field creation,
  then wait for explicit confirmation before `init apply --confirm`. Never request or echo a token.
  The CLI first reuses `gh auth login`, then falls back to environment tokens.
- `create <title>`: require an explicit user request. Load `settings`, use the configured create
  model only to normalize the supplied title without adding intent, then run `create --title ...`.
  Creation always makes a Project draft and immediately binds it. Never create repository issues.
- `bind <itemId>` / `unbind <itemId>`: run only from the user's current command. Never infer either
  operation from conversation or from `check` suggestions.
- `check`: run the read-only comparison and show `suggestedAdd` / `suggestedRemove`. It never changes
  bindings and never advances the update checkpoint.
- `status`: show only unresolved summaries for this session. Use `status --all` only when requested.
  Present `creationPolicyLine` and `kanbanStatusLine` as separate lines. `status resolve <errorId>`
  appends a resolution event; it never rewrites the log.
- `update`: use the workflow below. The Stop hook may explicitly request this same workflow.

CLI pattern:

```text
node <plugin-root>/scripts/mineprogress.mjs <command> --session <session_id> --data-dir <data_dir>
```

Initialization uses the same data directory and no session flag:

```text
node <plugin-root>/scripts/mineprogress.mjs init preview --project-url <url> --repository <owner/name> --data-dir <data_dir>
node <plugin-root>/scripts/mineprogress.mjs init apply --project-url <url> --repository <owner/name> --confirm --data-dir <data_dir>
```

## Update workflow

1. Run `update prepare`. If it returns `noop`, report that result; a no-bound-item no-op already
   advances the checkpoint. If it returns `resume_apply`, run `update apply` without a review file to
   resume the already approved transaction. Otherwise use exactly its incremental `context` and
   `boundItems`.
2. Use the configured update model and reasoning effort to generate only the JSON plan described by
   `prompt`. Do not write to GitHub yet.
3. Save the plan in a temporary file outside the repository and run `update stage --plan <file>`.
   On static rejection, regenerate; do not review an invalid plan.
4. Delegate semantic review to a distinct reviewer subagent using the returned review model,
   `prompts/review.md`, the journal, bound items, plan, and static report. The reviewer returns only
   approve/reject and cannot edit the plan.
5. Save that response temporarily and run `update apply --review <file>`. Approval applies only the
   staged bound-item fields and advances the checkpoint. Rejection returns to step 2.

For a Stop-triggered update, keep successful processing silent and let the thread stop. Report only
failures. For a manual `$mineprogress update`, report the outcome normally.

At most five generated plans are allowed, including the first. Stop immediately when `exhausted` is
true. Do not restart an exhausted run automatically; only use `update retry` after the user explicitly
requests another attempt. Infrastructure errors (token/auth/network/project/config/data/model/subagent) do not consume a
content retry. Record model, subagent, or denied-elevation failures with the internal `record-error`
CLI command, then stop. If the CLI returns `requestElevation:true`, request sandbox elevation and
retry the exact command once with `MINEPROGRESS_ELEVATED_RETRY=1`; do not treat that as a content
failure.

## Safety

Never put Project content, plans, or errors in repository files. Use only the official plugin data
directory. Never expose the full JSONL log. Do not expand an update beyond concrete evidence, and
redact names, emails, usernames, tokens, and local paths. `preferFastMode` is a preference: Fast is a
session-wide Codex setting, not a per-subagent model option.
