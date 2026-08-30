# Created-item proposal contract

Apply this contract only to bound items whose `bindingSource` is `create`, `backfillRequested` is
true, and `proposalWritable` is true. Use the inherited full thread as source evidence, including
messages from before Mineprogress was installed or invoked. Return `itemId`, `status`, `summary`,
`body`, and `comment`; use `null` when unchanged.

- Produce the item's one-time academic-style project proposal inside
  `<!-- mineprogress:managed:start -->` and `<!-- mineprogress:managed:end -->`.
- Do not generate a `## Repository` section. The script inserts the bound primary repository and its
  description in that location after review.
- Use these non-empty sections in order: `## Abstract`, `## Background and Significance`,
  `## Problem Statement`, `## Objectives`, `## Scope and Research Questions`,
  `## Methodology and Technical Approach`, `## Expected Deliverables and Evaluation Criteria`,
  `## Work Plan and Milestones`, and `## Risks, Constraints, and Security`. Add `## References`
  only for sources present in the evidence.
- Aim for a substantive 800-1500 word proposal when evidence supports it. Prefer an explicit
  `To be determined` over invented details, references, results, dates, or identities.
- Describe the accepted baseline, not a conversation transcript or changelog. Preserve any manual
  text outside existing managed markers exactly.
- Keep `summary` compact for the Project board and set `comment` to null. The script permits this
  body write only once and locks Issue bodies after confirmation.
