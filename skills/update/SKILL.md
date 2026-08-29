---
name: update
description: Review and apply an incremental update to bound GitHub Project items for the current thread.
---

# Update Bound Items

Read [the shared runtime contract](../.shared/runtime.md). For a manual invocation, run `update
prepare`. If it returns `noop`, report that result. If it returns `resume_apply`, run `update apply`
without a review file to resume the approved transaction. Otherwise use exactly its incremental
`context` and `boundItems`:

1. Use the returned update model and reasoning effort to generate only the JSON plan described by
   `prompt`; do not write to GitHub.
2. Save the plan in a temporary file outside the repository and run `update stage --plan <file>`.
   Regenerate a statically rejected plan without sending it to review.
3. Delegate semantic review to a distinct reviewer subagent using the returned review model,
   `prompts/review.md`, journal, bound items, plan, and static report. The reviewer returns only
   approve or reject and cannot edit the plan.
4. Save the response temporarily and run `update apply --review <file>`. Approval writes only staged
   bound-item fields and advances the checkpoint; rejection returns to plan generation.

Allow at most five generated plans, including the first. Stop when `exhausted` is true. Only an
explicit `$mineprogress:update retry` may start a new run over an exhausted journal. Infrastructure
errors do not consume a content retry; record model, subagent, or denied-elevation failures with
`record-error` and stop.

For a Stop-triggered update, follow the hook's equivalent workflow, keep success silent, and report
only failure. `preferFastMode` is a session preference, not a per-subagent model option.
