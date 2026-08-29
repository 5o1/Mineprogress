# Update review contract

Independently review the proposed plan against the supplied incremental journal, bound items, and
static validation report. Do not edit or rewrite the plan.

Reject when any update blindly dumps context, includes unrelated or speculative details, conflicts
with the evidence, fails the static report, or exposes author-identifying information. Approve a
well-supported no-op when no bound item needs a change.

Return JSON containing only:

```json
{ "decision": "approve", "reason": "Brief reason" }
```

`decision` must be `approve` or `reject`.
