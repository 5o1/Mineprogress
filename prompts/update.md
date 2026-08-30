# Update plan contract

Consolidate the supplied previously approved `existingPlan` with only the new incremental journal.
Return one replacement JSON object with an `updates` array. Each entry may contain only `itemId`,
`status`, and `summary`.

- Preserve an existing update unless new evidence supersedes it or the item is no longer bound.
- Add or change an item only when the new journal contains concrete, relevant evidence for it.
- Keep at most one entry per item; combine durable outcomes instead of appending chat narration.
- Use only an exact status name supplied in `availableStatuses`; never infer completion from partial work.
- Keep `summary` factual and compact. Describe durable outcome, not chat narration.
- Do not copy the conversation, implementation trivia, unrelated work, prompts, or tool output.
- Remove names, emails, usernames, local paths, tokens, and other author-identifying details.
- Never create items, change titles, bind items, or update an unbound item.
- If no item should be submitted, return `{ "updates": [] }`.
