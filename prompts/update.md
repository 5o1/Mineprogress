# Incremental update contract

Consolidate `existingPlan` with only the new incremental journal. Return one replacement JSON object
with an `updates` array. Each entry contains `itemId`, `status`, `summary`, `body`, and `comment`; use
`null` when a field should not change.

- `existingPlan` is queued but not yet confirmed on GitHub. Preserve every item and every non-null
  field it contains. Never remove an existing body or replace an existing pending comment. Extend
  the managed history without deleting or paraphrasing its already approved lines.
- Update an item only for an accepted requirement, durable decision, verified result, or meaningful
  status transition. Questions, troubleshooting observations, and chat about Mineprogress itself are
  not progress unless the user adopts them as requirements for that item.
- Keep `summary` factual and compact for the Project board.
- For Issue or Draft content, return the complete proposed body. Preserve text outside the managed
  markers exactly. Inside `## Historical Progress`, append or consolidate dated segments in ascending
  order; every segment has `#### Requirements` and `#### Results`. Never use `Current Progress`.
- A comment is optional and supported only by Issues or pull requests. Add one only when this pass
  records a meaningful new result or status transition; do not comment for ordinary Q&A, initial
  backfill, wording cleanup, or a summary-only change.
- Use only an exact `availableStatuses` value and never infer completion from partial work.
- Do not include implementation trivia, prompts, tool output, speculation, or author-identifying data.
- Never report the current Mineprogress control flow as item progress. Generator attempts, static
  checks, reviewer decisions or wait states, worker execution, and pending-plan state are control
  metadata even when the conversation discusses them.
- Never create items, change titles, bind items, or update an unbound item.
- If nothing durable changed, return `{ "updates": [] }`.
