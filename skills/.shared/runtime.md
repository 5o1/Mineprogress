# Shared Runtime

Resolve the plugin root as two directories above the current Skill directory. Read the Mineprogress
context attached to the explicit command for `session_id` and `data_dir`; never guess either value.
Idle hooks create no state until a binding or explicit Mineprogress command exists. A new binding
schedules one full-thread backfill through an ephemeral Codex fork; later planning uses only the
incremental journal. Invoke stateful commands as:

```text
node <plugin-root>/scripts/mineprogress.mjs <command> --session <session_id> --data-dir <data_dir>
```

Initialization omits `--session`. Never write Project content, plans, errors, or cache files into a
working repository. The CLI first reuses `gh auth login`, then falls back to environment tokens;
never request or echo a token. If it returns `requestElevation:true`, request sandbox elevation and
retry the exact command once. For a pending submission, add `--elevated-retry` to that exact
`update submit` command so Mineprogress can persist and verify the retry state.
