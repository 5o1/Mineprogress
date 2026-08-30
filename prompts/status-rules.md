# Kanban status-rule generation contract

Generate one JSON object from the exact synchronized Project status names, default status, terminal
statuses, and ordinary software-delivery semantics supplied by the command. Do not use conversation
content, existing item text, personal information, or Mineprogress control state.

Return only `statuses` and `transitions`:

- `statuses` contains every available status exactly once. Each entry has exact `name`, a concrete
  `enterWhen` boundary, and a concrete `doNotEnterWhen` boundary.
- `transitions` contains `from`, `to`, `when`, and `doNotApplyWhen`. Use exact status names, no
  self-transitions, and no duplicate pair.
- Make every available status reachable from the default status. Include rejection/rework,
  blocking/recovery, and reopening paths when those statuses exist.
- Treat review of the actual work as a workflow state. Mineprogress's internal content reviewer,
  generator, background worker, and submission mechanics never justify a Project status change.
- Require observable evidence. New requirements alone are not completion; implementation alone is
  not review approval; passing review alone is not completion when required verification or work
  remains.
