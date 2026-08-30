# Configuration

Mineprogress requires Node.js 22+ and has no npm runtime dependencies. It first reuses the active
`gh auth login` session and falls back to `GITHUB_TOKEN` or `GH_TOKEN`. Tokens stay in memory and are
never written to configuration or logs. Then run `$mineprogress:init`. The guide requests a Project
URL, reads its linked repositories, initializes immediately, and reports the saved configuration.
GitHub Projects support one default repository, but the public GraphQL API exposes only the linked
repository list, not which repository is the default. Mineprogress therefore adopts a sole linked
repository as its Issue repository; multiple linked repositories require an explicit choice. With
no Issue repository it creates drafts. It creates a missing `Update` text field, but it will not
invent a missing Status field.

Codex retries `gh` authentication once with sandbox elevation before deciding that a login is
missing. This avoids treating a sandbox-blocked credential store as a logged-out GitHub CLI.

`MINEPROGRESS_CONFIG` remains available as an advanced override for development or centrally managed
configuration. `config.example.json` documents the complete schema; users do not need to copy it.

## GitHub Project

- `owner`: user or organization login.
- `ownerType`: `user` or `organization`.
- `projectNumber`: the number shown in the Project URL.
- `creation.repository`: repository in which Mineprogress creates Issues, in `owner/name` form. It
  should normally match the Project's default repository. The legacy `defaultRepository` key is
  accepted on load and normalized when configuration is next saved.
- `statusFieldName` / `updateFieldName`: single-select status and concise update text fields.
- `kanban.defaultStatus`: status assigned immediately to every newly created item. Initialization
  prefers common starting names such as `Todo` or `Backlog`, then falls back to the first
  non-terminal option.
- `kanban.terminalStatuses`: statuses that close linked Issues. Initialization recognizes
  conventional terminal names such as `Done`, `Completed`, or `Closed`; users can override the list.
- `update.maxBodyCharacters` / `maxCommentCharacters`: static limits for managed Markdown content.

## Content contracts

`prompts/content-metadata.md`, `prompts/create.md`, `prompts/bind.md`, and `prompts/update.md` control
generation behavior. Every binding stores `contentLanguage`: create and bind default it to `en`,
while an explicit `--language <tag>` changes only that item. Generators do not infer language from
the thread or existing content. The backend supplies external links found in the new journal, and
the active host adapter may add the workspace remote; generation and review retain only links
directly relevant to the item. The workspace remote is persisted as `primaryRepository` metadata
with a short description instead of being rediscovered or inferred from existing item content.
`prompts/review-checklist.md` independently controls semantic review. They are packaged plugin
resources loaded only for an active background update, not global Codex instructions. A created
item receives one academic-style proposal. After confirmation, the script API rejects every Issue
body mutation except deterministic replacement of its script-owned `## Repository` section; Issue
history is stored in dated comments. Drafts cannot receive comments, so their bodies may grow only
by an exact-prefix append. Remote content is read again before any body mutation to prevent a stale
plan from overwriting an external edit.

`check` reads the real options from the Status field and saves them in the global plugin cache.
Only configured `kanban.terminalStatuses` produce removal suggestions or synchronize linked Issues
to closed. A Mineprogress update that moves a linked Project item back to a non-terminal status
reopens its Issue. Direct edits on github.com require a GitHub Project workflow because a local
plugin cannot receive those remote events.

## Creation routes

`creation.projectVisibility` and `creation.repositoryVisibility` default to `auto`. The four
`creation.routes` defaults are:

| Project | Issue repository | Create as |
| --- | --- | --- |
| public | private | issue |
| public | public | issue |
| private | private | issue |
| private | public | draft |

Without an Issue repository, creation uses a draft. `status` reads the latest cached visibility
inspection offline. Each route can be changed to `issue` or `draft` in the configuration.

## Models

`models.create`, `models.update`, and `models.review` independently set `model` and
`reasoningEffort`. All default to `gpt-5.6-luna` with `medium` effort. `preferFastMode` records a
preference only: Fast is a Codex session setting and cannot be enabled per subagent.
