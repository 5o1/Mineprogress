# Item content metadata contract

Each bound item has an authoritative `contentLanguage` language tag. Write every newly generated
`summary`, proposal passage, progress comment, or Draft append for that item in that language. Do
not infer language from the conversation, title, existing body, or other items. When the user did
not specify a language during create or bind, the stored value is `en`.

`statusRules` is the authoritative workflow policy generated for the current Project status set.
Evaluate the outgoing rules for every bound item on each durable update. Change an item's status
only through an exact listed transition whose `when` boundary is supported by item evidence and
whose `doNotApplyWhen` boundary is false. Do not force a transition when evidence is ambiguous. Do
not treat Mineprogress generation, review, validation, background work, or submission as evidence
that project work entered Review or another status. When rules are unavailable, leave status
unchanged.

`evidenceLedger.facts` contains compact evidence recovered from verified Mineprogress GitHub writes;
`pendingEvidenceFacts` contains reviewed evidence whose transaction is not yet verified. Use both with
the new journal and current remote fields when evaluating status rules. `statusIntent`, when present,
is a durable user-requested target that the plan must satisfy. Do not discard it merely because its
original journal entry has already been converted into evidence or submitted to GitHub.

`primaryRepository` is authoritative binding metadata. The script maintains that repository and its
description in the Issue proposal's `## Repository` section; do not repeat it in a progress comment
unless the repository itself is directly relevant to that delta. `referenceLinks` contains other
external-link candidates extracted from the new journal and the current workspace. Cite links that
directly identify this item's Issues, pull requests, artifacts, or durable supporting sources.
During full-thread backfill, also retain material external links visible in the inherited thread even
if they are not in the candidate list. Use Markdown links in the relevant proposal References section
or progress statement. Do not copy unrelated CI, temporary download, debugging, or incidental links
merely because they are present.
