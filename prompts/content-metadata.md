# Item content metadata contract

Each bound item has an authoritative `contentLanguage` language tag. Write every newly generated
`summary`, proposal passage, progress comment, or Draft append for that item in that language. Do
not infer language from the conversation, title, existing body, or other items. When the user did
not specify a language during create or bind, the stored value is `en`.

`primaryRepository` is authoritative binding metadata. The script maintains that repository and its
description in the Issue proposal's `## Repository` section; do not repeat it in a progress comment
unless the repository itself is directly relevant to that delta. `referenceLinks` contains other
external-link candidates extracted from the new journal and the current workspace. Cite links that
directly identify this item's Issues, pull requests, artifacts, or durable supporting sources.
During full-thread backfill, also retain material external links visible in the inherited thread even
if they are not in the candidate list. Use Markdown links in the relevant proposal References section
or progress statement. Do not copy unrelated CI, temporary download, debugging, or incidental links
merely because they are present.
