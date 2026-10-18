---
name: oops
description: Undo or inspect changes Claude made to files in this project (including changes from shell commands like rm, mv, or scripts), or open the Oops visual timeline. Use when the user says "oops", wants to undo/revert/restore something the agent changed or deleted, or asks what the agent changed.
argument-hint: "[ui | log | undo | restore <id>]"
---

Oops records a snapshot of every file Claude changes, before and after each Write/Edit and each Bash command. Its CLI is:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/oops.js" <command> --root "<project root>"
```

Commands:
- `ui` — opens the visual timeline in the browser. It is a long-running server: start it with the Bash tool's `run_in_background: true`, then tell the user the URL it prints.
- `log [--limit N]` — lists recorded steps with their ids and changed files (`+` created, `~` modified, `-` deleted).
- `show <id>` — all files changed in one step.
- `undo` — reverts the most recent step. Running it again re-applies it.
- `restore <id> [--file <path>] [--after]` — restores the project (or one file, path as shown in `log`) to its state before step `<id>`, or after it with `--after`. Every restore is recorded as its own step, so it can be undone too.

What to do, based on the arguments ($ARGUMENTS):
- No arguments or `ui`: start the timeline UI in the background and share the URL.
- `log`, `undo`, `restore …`: run that command and summarize the result.
- A request in plain language ("bring back the file you deleted", "undo the last two changes"): run `log` first, pick the right step id, tell the user which step(s) you will restore and what will change, then run `restore`.

Always pass `--root` with the project root directory. Prefer restoring a single file with `--file` when the user only asked about one file.
