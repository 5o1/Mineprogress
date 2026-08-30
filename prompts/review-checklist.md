# Reviewer checklist

Reject the plan if any answer is unsatisfactory:

1. Evidence: Is every requirement, result, status, summary, proposal statement, and progress entry
   directly supported by the relevant thread evidence or existing item?
2. Relevance: Did the generator avoid dumping conversation, Q&A, prompts, tool output, debugging
   chatter, and unrelated implementation details?
3. Proposal: Is a body replacement limited to a writable created-item proposal, with the required
   substantive academic sections, no invented facts, and unchanged manual surrounding text?
4. Immutability: Is an Issue body null or an exact copy of an already queued proposal? Is every
   Draft body change strictly append-only?
5. Changelog: Does each new comment or Draft suffix use a dated Progress Update with non-empty
   Requirements and Results, recording only the new delta?
6. Preservation: Because `existingPlan` is unconfirmed, are all its items and non-null fields
   retained, with pending comments and Draft bodies preserved as exact prefixes?
7. Static checks: Is `staticReport.valid` true, including item, status, size, proposal-lock, and
   append-only checks?
8. Privacy: Are names, usernames, emails, local paths, tokens, and other author-identifying details
   absent?
9. Control-plane isolation: Does the plan omit generator, reviewer, validation, worker, and
   submission state?
10. Language: Does each newly generated field use the item's authoritative `contentLanguage`, without
    inferring a replacement language from the conversation or existing content?
11. References: Does the plan retain directly relevant repository, Issue, pull request, artifact,
    and durable-source links from `referenceLinks` or full-thread evidence while omitting incidental
    and unrelated URLs?
12. Primary repository: Does the plan leave `primaryRepository` synchronization to the script and
    avoid redundantly copying that stable link into unrelated progress comments?
13. Status transition: Does every proposed status change follow an exact `statusRules` transition,
    satisfy its evidence boundary, and avoid every stated exclusion without confusing Mineprogress's
    internal reviewer with review of the project work? Does it satisfy any durable `statusIntent`
    using the verified `evidenceLedger`, pending evidence, new journal, and current remote state?
14. Journal completeness: Is every incremental journal sequence classified exactly once? Does each
    `included` entry point to an item with a real plan delta, each `irrelevant` entry contain no
    durable project change, and each omitted durable change force `missing` plus rejection?
15. Interruption safety: Does approval leave no unaccounted journal entry that could be deleted when
    the reviewed batch is atomically committed after a process restart?
