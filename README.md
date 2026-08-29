# Mineprogress

Bind a Codex thread to GitHub Project items and silently update the relevant Kanban work at the end of every conversation.

## Usage

Provide `GITHUB_TOKEN` or `GH_TOKEN` with minimum Projects read/write access, install the plugin,
start a new Codex thread, and run the guided initializer:

```text
$mineprogress init
```

The guide asks for a GitHub Project URL and default repository, previews detected fields, statuses,
visibility, and creation behavior, then saves the confirmed configuration in Codex's plugin data
directory. No configuration file is added to the working repository.

Mineprogress uses an explicit Codex Skill command:

```text
$mineprogress create "Implement import validation"
$mineprogress bind PVTI_lADO...
$mineprogress check
$mineprogress status
```

- `create` follows the Project/repository visibility rules, creates a draft or issue, and binds it.
- `bind` adds a Project item to the current thread's candidate list.
- `check` discovers actual Kanban statuses and suggests items to bind or unbind without changing them.
- `status` works offline and shows the creation route, available statuses, and unresolved errors.

See [Configuration](docs/configuration.md), [Workflow](docs/workflow.md), and
[Development and release](docs/development.md) for details.

## License

MIT License, copyright [@5o1](https://github.com/5o1).
