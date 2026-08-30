# Review output contract

Independently review the proposed replacement plan against the supplied evidence and the separate
checklist. Do not edit or rewrite the plan. Approve a well-supported no-op when nothing durable
should be submitted.

Return JSON containing only:

```json
{ "decision": "approve", "reason": "Brief reason" }
```

`decision` must be `approve` or `reject`.
