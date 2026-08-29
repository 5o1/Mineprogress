# Configuration

Mineprogress requires Node.js 22+ and has no npm runtime dependencies. Supply a token through
`GITHUB_TOKEN` or `GH_TOKEN`, then run `$mineprogress init`. The conversational guide requests a
Project URL and optional default repository, previews the detected configuration, asks for
confirmation, and writes `PLUGIN_DATA/config.json`. It can create a missing `Update` text field after
confirmation, but it will not invent a missing Status field.

`MINEPROGRESS_CONFIG` remains available as an advanced override for development or centrally managed
configuration. `config.example.json` documents the complete schema; users do not need to copy it.

## GitHub Project

- `owner`: user or organization login.
- `ownerType`: `user` or `organization`.
- `projectNumber`: the number shown in the Project URL.
- `defaultRepository`: default repository in `owner/name` form.
- `statusFieldName` / `updateFieldName`: single-select status and concise update text fields.

`check` reads the real options from the Status field and saves them in the global plugin cache.
GitHub does not assign completion semantics to those options, so only names explicitly listed in
`kanban.terminalStatuses` produce removal suggestions. The empty default makes no assumption.

## Creation routes

`creation.projectVisibility` and `creation.repositoryVisibility` default to `auto`. The four
`creation.routes` defaults are:

| Project | Default repository | Create as |
| --- | --- | --- |
| public | private | issue |
| public | public | issue |
| private | private | issue |
| private | public | draft |

Without a default repository, creation uses a draft. `status` reads the latest cached visibility
inspection offline. Each route can be changed to `issue` or `draft` in the configuration.

## Models

`models.create`, `models.update`, and `models.review` independently set `model` and
`reasoningEffort`. All default to `gpt-5.6-luna` with `medium` effort. `preferFastMode` records a
preference only: Fast is a Codex session setting and cannot be enabled per subagent.
