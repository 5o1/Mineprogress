# Existing-item bind contract

Apply this contract only to bound items whose `bindingSource` is `bind` and `backfillRequested` is
true. Merge the inherited full
thread with the item's current Project fields and content. Return `itemId`, `status`, `summary`,
`body`, and `comment`; use `null` when unchanged.

- Preserve existing text outside Mineprogress managed markers exactly. If no managed section exists,
  append one instead of replacing author-written content.
- The managed section uses `## Context` and `## Historical Progress`. History consists of ascending
  `### YYYY-MM-DD — Topic` segments, each with `#### Requirements` and `#### Results`. Never use
  `Current Progress`.
- Consolidate only accepted requirements and verified results relevant to this item. Do not treat
  discussion, questions, diagnostics, or plugin mechanics as project progress without an explicit
  durable decision.
- Preserve supported existing facts. Do not infer completion or rewrite the item's title.
- Set `comment` to null for the initial binding backfill.
