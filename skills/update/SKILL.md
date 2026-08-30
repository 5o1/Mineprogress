---
name: update
description: Consolidate, review, and optionally submit updates for bound GitHub Project items.
---

# Update Bound Items

Read [the shared runtime contract](../.shared/runtime.md). For a manual invocation, run `update
prepare`. Report `noop`; submit `pending_submission`; for `submission_unverified`, submit and prepare
again so reconciliation precedes revision. For `resume_apply`, run `update apply` without a review
file. Otherwise use its `existingPlan`, incremental `context`, and `boundItems`.

When `useThreadHistory` is true, also use the current thread's complete inherited conversation as
source evidence, including messages from before installation. Give the reviewer the same evidence.

1. Use the returned update model and effort to generate the consolidated JSON plan described by
   `prompt`; do not write to GitHub.
2. Save the plan in a temporary file outside the repository and run `update stage --plan <file>`.
   Regenerate a statically rejected plan without sending it to review.
3. Give a distinct reviewer subagent the returned review model, `prompts/review.md`, evidence, plan,
   and static report. It returns only approve or reject and cannot edit the plan.
4. Save the response temporarily and run `update apply --review <file>`. Regenerate after rejection.
   For a manual invocation, finish with `update submit`.

Allow five generated plans. Stop on `exhausted`; only explicit `$mineprogress:update retry` restarts
that journal. Infrastructure errors consume no content retry; record model, subagent, or denied-
elevation failures with `record-error` and stop.

Automatic Stop revisions run in the plugin's asynchronous background worker, not in the foreground
agent using this Skill. Do not duplicate that work when a manual command was not requested.
`preferFastMode` is a session preference, not a per-subagent model option.
