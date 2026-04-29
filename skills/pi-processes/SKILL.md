---
name: pi-processes
description: Manage long-running commands in the background with the process tool. Use when a task needs a dev server, test watcher, build watcher, local API, or log tail to keep running while the conversation continues.
---

# pi-processes

Use this skill when work needs a long-running command to stay alive while Pi continues with other steps.

## Prefer this workflow

- Use the `process` tool for long-running commands.
- Avoid shell background patterns when the process tool fits.
- Give processes stable, clear names.
- Continue the task after starting a process instead of waiting on it.
- Do not run `sleep`, wait loops, or repeated `output` calls just to give the process time; configure `alertOnSuccess`, `alertOnFailure`, `logWatches`, or `monitorGroup` and let Pi notify you.
- If no independent work remains, tell the user the process is monitored and stop the turn instead of sleeping.
- Inspect output or log files only when needed.
- If several processes belong to one workflow, use `monitorGroup` instead of polling `list`/`output`: `groupMode: "all"` for WhenAll-style completion, `groupMode: "any"` for WhenAny-style completion. With `triggerTurn: true`, the group gives one aggregate lifecycle follow-up instead of separate per-process completion/failure turns.
- If watches or alert flags are wrong, use `process` action `update` instead of polling or restarting expensive work.
- Kill and clear processes when they are no longer useful.

## Good fits

- `pnpm dev`
- `npm run server`
- `pnpm test --watch`
- `tail -f <logfile>`
- local preview or build watchers

## Typical flow

1. Start the long-running command with a clear name.
2. Add alert flags or log watches for the condition that should bring you back.
3. For multiple related processes, register `monitorGroup` over their process IDs.
4. Continue the main task, or stop the turn if there is no useful independent work.
5. Inspect `output` or `logs` only when something needs attention.
6. Use `update` to add, replace, remove, clear, or replay log watches when the original watch config was missing, noisy, or wrong.
7. Kill and clear processes or group monitors when done.

## Anti-pattern to Avoid

Do not do this after `process` starts a monitored command:

```bash
sleep 150; true
```

That blocks the agent instead of using Pi's monitoring. Prefer:

1. Start with `alertOnSuccess: true` when one process completion matters, add a `logWatch` for a marker, or use `monitorGroup` when several processes must finish together.
2. Do at most one quick `output` sanity check if it changes your next action.
3. Continue other work, or stop the turn and let the watch/exit/group notification bring you back.

## Notes

- Users can inspect and manage running processes from `/ps`.
- Use `write` when a process expects stdin input.
- Use `output` for a quick tail and `logs` when the full log files are more useful.
- Do not repeatedly call `output` just to wait for a marker; add or fix a `logWatch` with `update` and, if the marker may already have appeared, use a small `replayTailLines` value.
