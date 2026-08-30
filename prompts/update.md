# Incremental update contract

Consolidate `existingPlan` with only the new incremental journal. Return one replacement JSON object
with an `updates` array. Each entry contains `itemId`, `status`, `summary`, `body`, and `comment`; use
`null` when a field should not change.

- Preserve every queued item and non-null field until GitHub confirms submission. Preserve a
  pending Issue proposal body exactly. Preserve a pending comment or Draft body as an exact prefix
  before appending another progress block.
- Update only for an accepted requirement, durable decision, verified result, or meaningful status
  transition. Ordinary Q&A and transient diagnostics are not project progress.
- Keep `summary` factual and compact for the Project board. Use only exact available statuses.
- Issue bodies are immutable after their created-item proposal. Always return `body: null` for an
  Issue unless copying an already queued proposal verbatim. Record each meaningful delta in an
  append-only comment using `## Progress Update — YYYY-MM-DD — Topic`, then non-empty
  `### Requirements` and `### Results` sections.
- Drafts do not support comments. Return `comment: null` and append the same progress block to the
  complete existing or pending Draft body without changing any prior byte.
- Do not include prompts, tool output, speculation, author-identifying data, or Mineprogress worker,
  generator, reviewer, validation, or submission execution state. This excludes transient narration
  about the current publication pipeline, not durable implementation work on Mineprogress itself.
  Product changes to hooks, workers, generators, validation, caches, and recovery are progress when
  supported by repository or CI evidence.
- Never create items, change titles, bind items, or update an unbound item. If nothing durable
  changed and no plan is pending, return `{ "updates": [] }`. If `existingPlan` is pending, preserve
  it exactly even when the new journal is entirely irrelevant.
