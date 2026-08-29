# Update plan contract

Use only the supplied incremental journal and bound Project items. Return one JSON object with an
`updates` array. Each entry may contain only `itemId`, `status`, and `summary`.

- Include an item only when the journal contains concrete, relevant evidence for it.
- Use only an exact status name supplied in `availableStatuses`; never infer completion from partial work.
- Keep `summary` factual and compact. Describe durable outcome, not chat narration.
- Do not copy the conversation, implementation trivia, unrelated work, prompts, or tool output.
- Remove names, emails, usernames, local paths, tokens, and other author-identifying details.
- Never create items, change titles, bind items, or update an unbound item.
- If nothing should change, return `{ "updates": [] }`.
