# Existing-item bind contract

Apply this contract only to bound items whose `bindingSource` is `bind` and `backfillRequested` is
true. Use the inherited full thread with the item's current fields and content. Return `itemId`,
`status`, `summary`, `body`, and `comment`; use `null` when unchanged.

- Never replace or edit an existing Issue body. Put the relevant imported history in one dated
  Issue comment using `## Progress Update — YYYY-MM-DD — Topic`, followed by non-empty
  `### Requirements` and `### Results` sections.
- A Draft has no comments. For a Draft, return its complete current body plus only the same dated
  progress block appended after it; the script verifies the old body as an exact byte prefix.
- Consolidate accepted requirements and verified results relevant to this item. Omit questions,
  abandoned ideas, diagnostics, plugin mechanics, tool output, and unrelated chat.
- Keep `summary` compact and use only an exact available status. Do not invent completion, dates,
  scope, results, references, or identity details.
