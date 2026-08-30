# Create backfill contract

Apply this contract only to bound items whose `bindingSource` is `create` and `backfillRequested` is
true. Use the inherited full
thread as source evidence, including messages from before Mineprogress was installed or invoked.
Return `itemId`, `status`, `summary`, `body`, and `comment`; use `null` when unchanged.

- Build an initial long-form body within `<!-- mineprogress:managed:start -->` and
  `<!-- mineprogress:managed:end -->`.
- Use `## Context` for a compact description of the task and `## Historical Progress` for its record.
- Under Historical Progress, create dated `### YYYY-MM-DD — Topic` segments in ascending order.
  Every segment must contain `#### Requirements` and `#### Results`. Use `Pending` only when the
  evidence contains a requirement but no result yet. Never use a `Current Progress` section.
- Group related exchanges into meaningful phases rather than copying turns. Record accepted
  requirements and verified results; omit questions, abandoned ideas, tool output, and unrelated chat.
- Keep `summary` short enough for the Project board. Set `comment` to null for initial creation.
- Do not invent dates, results, status, scope, or identity details. Use `planningDate` only for an
  undated current phase.
