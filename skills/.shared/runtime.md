# Shared Runtime

Resolve the plugin root as two directories above the current Skill directory. Read the SessionStart
context for `session_id` and `data_dir`; never guess either value. Invoke stateful commands as:

```text
node <plugin-root>/scripts/mineprogress.mjs <command> --session <session_id> --data-dir <data_dir>
```

Initialization omits `--session`. Never write Project content, plans, errors, or cache files into a
working repository. The CLI first reuses `gh auth login`, then falls back to environment tokens;
never request or echo a token. If it returns `requestElevation:true`, request sandbox elevation and
retry the exact command once with `MINEPROGRESS_ELEVATED_RETRY=1`.
