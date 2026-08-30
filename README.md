# Mineprogress

Bind a Codex thread to GitHub Project items, maintain structured progress history in the background, and silently submit it when the conversation ends.

## Usage

Install the plugin, start a new Codex thread, and run the guided initializer. Mineprogress reuses the
active GitHub CLI login automatically:

```text
$mineprogress:init
```

The guide asks for a GitHub Project URL and reports the resulting statuses, visibility, and creation
behavior. GitHub permits one default repository but does not expose it through the public GraphQL
API. Mineprogress uses a sole linked repository as its Issue repository; if several are linked, it
asks which one to use. No configuration file is added to the working repository.

Mineprogress uses an explicit Codex Skill command:

```text
$mineprogress:create "Implement import validation"
$mineprogress:bind PVTI_lADO...
$mineprogress:unbind PVTI_lADO... --delete
$mineprogress:check
$mineprogress:status
```

- `create` creates and binds an item, then writes a one-time academic project proposal from the complete earlier thread.
- `bind` adds an existing Project item without replacing its existing Issue body.
- `unbind` normally removes only the thread binding; explicit `--delete` also closes a linked Issue
  and removes the Project item.
- `check` discovers actual Kanban statuses and suggests items to bind or unbind without changing them.
- `status` works offline and shows the creation route, available statuses, and unresolved errors.

See [Configuration](docs/configuration.md), [Workflow](docs/workflow.md), and
[Development and release](docs/development.md) for details.

## License

MIT License, copyright [@5o1](https://github.com/5o1).
