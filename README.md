# Mineprogress

Bind a Codex thread to GitHub Project items, maintain structured progress history in the background, and silently submit it when the conversation ends.

## Usage

Install the plugin, start a new Codex thread, and run the guided initializer. Mineprogress reuses the
active GitHub CLI login automatically:

```text
$mineprogress:init
```

The guide asks for a GitHub Project URL, uses its linked repository automatically, initializes the
plugin, and reports the resulting statuses, visibility, and creation behavior. It asks which
repository to use only when the Project links several. No configuration file is added to the
working repository.

Mineprogress uses an explicit Codex Skill command:

```text
$mineprogress:create "Implement import validation"
$mineprogress:bind PVTI_lADO...
$mineprogress:check
$mineprogress:status
```

- `create` creates and binds an item, then backfills its long-form Historical Progress from the complete earlier thread.
- `bind` adds an existing Project item and preserves manual content while adding managed history.
- `check` discovers actual Kanban statuses and suggests items to bind or unbind without changing them.
- `status` works offline and shows the creation route, available statuses, and unresolved errors.

See [Configuration](docs/configuration.md), [Workflow](docs/workflow.md), and
[Development and release](docs/development.md) for details.

## License

MIT License, copyright [@5o1](https://github.com/5o1).
