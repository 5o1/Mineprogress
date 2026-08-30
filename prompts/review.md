# Update review contract

Independently review the consolidated proposed plan against the previously approved plan, new
incremental journal, bound items, and static validation report. Do not edit or rewrite the plan.

Reject when it drops still-relevant approved work without evidence, blindly dumps context, includes
unrelated or speculative details, conflicts with the evidence, fails the static report, or exposes
author-identifying information. Approve a well-supported no-op when nothing should be submitted.

Return JSON containing only:

```json
{ "decision": "approve", "reason": "Brief reason" }
```

`decision` must be `approve` or `reject`.
