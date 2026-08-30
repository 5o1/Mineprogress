# Reviewer checklist

Reject the plan if any answer is unsatisfactory:

1. Evidence: Is every requirement, result, status, summary, body change, and comment directly
   supported by the relevant thread evidence or existing item?
2. Relevance: Did the generator avoid dumping conversation, Q&A, prompts, tool output, debugging
   chatter, and unrelated implementation details?
3. Durability: Does the plan record accepted requirements and verified outcomes rather than guesses,
   temporary observations, or statements such as “unverified” with no actionable project meaning?
4. History: Does the managed body use `Historical Progress`, chronological dated segments, and a
   Requirements/Results pair for every segment, without a `Current Progress` section?
5. Preservation: Is manual content outside the managed markers unchanged, and is still-relevant
   approved work retained? Because `existingPlan` is not yet confirmed on GitHub, reject if any of
   its items, non-null fields, pending comment, or approved managed-body lines disappear.
6. Comment restraint: Is a comment present only for a meaningful new result or status transition,
   and absent for initial backfill, ordinary Q&A, or wording-only changes?
7. Static checks: Is `staticReport.valid` true, with allowed fields, item IDs, statuses, sizes, and
   body structure?
8. Privacy: Are names, usernames, emails, local paths, tokens, and other author-identifying details
   absent?
9. Control-plane isolation: Does the plan omit the current generator attempt, static-check result,
   reviewer decision or wait state, worker execution state, and pending-plan status? Reject these
   even when they appear in the incremental conversation.
