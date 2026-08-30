# Review output contract

Independently review the proposed replacement plan against the supplied evidence and the separate
checklist. Do not edit or rewrite the plan. Approve a well-supported no-op when nothing durable
should be submitted.

Classify every entry in `incrementalContext` exactly once in `journalCoverage`:

- `included`: durable evidence is represented by a real change to every listed bound `itemId`.
- `irrelevant`: the entry is Q&A, transient diagnostics, or other non-project material; use no item ids.
- `missing`: durable evidence is absent from the proposed plan; use no item ids and reject the plan.

Do not approve until every sequence is classified and no entry is `missing`. An unchanged plan or
no-op is approvable only when every new journal entry is genuinely irrelevant. Distinguish transient
Mineprogress update-pipeline narration from durable implementation work on the Mineprogress product
itself; product changes to hooks, workers, generators, validation, caches, or submission recovery are
project progress when supported by repository or CI evidence.

Return JSON containing only:

```json
{
  "decision": "approve",
  "reason": "Brief reason",
  "journalCoverage": [
    {
      "sequence": 12,
      "disposition": "included",
      "itemIds": ["bound-item-id"],
      "reason": "The requirement and verified result are represented in the appended progress entry."
    }
  ]
}
```

`decision` must be `approve` or `reject`. For a full-thread backfill with no local journal entries,
return an empty `journalCoverage` array.
