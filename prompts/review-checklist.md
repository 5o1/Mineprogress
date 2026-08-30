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
