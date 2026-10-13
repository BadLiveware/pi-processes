---
name: pi-processes
description: Manage long-running commands with the process tool. Use when a task needs a dev server, watcher, build, test watcher, local API, log tail, or other command to keep running while the conversation continues.
---

# pi-processes

Use the `process` tool for commands that should keep running while the agent continues working. Do not use shell background patterns such as `&`, `nohup`, `disown`, or `setsid` when `process` fits.

## The core loop: start, do not wait, get notified

A started process runs in the background and the manager brings you back when something happens. You do not need to sleep, poll, or hold your turn for a process to finish.

1. `process start` a long-running command, with `notify.logMatches` for the signals you care about.
2. End your turn or move on to other work. Do not call `process output` in a loop waiting for "ready".
3. The process notifies you when:
   - a `logMatches` pattern hits (readiness, error, progress),
   - the process exits successfully (`notify.onSuccess`, default `turn` when `notify` is supplied; otherwise the legacy default is context),
   - the process fails or crashes (`onFailure`, default `turn`; failures always notify),
   - the process is killed externally (`onKilled`, default `context`),
   - you stop the process intentionally (always `context`; notify config does not apply).
4. When a watch is too noisy or wrong, fix it with `process update` — do not restart the process just to change watches.
5. `process stop` obsolete live processes and `process clear` finished entries when they are no longer useful.

If the next step requires a readiness signal, add a log watch and end the turn rather than sleeping or polling.
Use a provider-native watch command, such as `gh run watch <run-id> --exit-status`, as a managed process when an external service offers one.
The command watches remote state; the agent does not poll it.

## Aggregate monitors

For multiple managed processes, use `monitorGroup` instead of polling their output or running a shell wait loop.
`processIds` accepts up to 50 unique existing process IDs.
`groupMode: "all"` waits for all members; `failFast` defaults to true and triggers on the first failed or killed member.
Use `failFast: false` to wait for all outcomes even after a failure.
`groupMode: "any"` triggers on the first settled member.
Already settled members are evaluated at registration.

```json
{
  "action": "monitorGroup",
  "name": "build-and-tests",
  "processIds": ["proc_1", "proc_2"],
  "groupMode": "all",
  "failFast": true,
  "triggerTurn": true
}
```

`triggerTurn` defaults to true: the group owns lifecycle follow-up turns and member exits remain context-only.
This ownership continues after an early failure or an any-mode result, until the monitor is cleared.
Log watches can still wake the agent.
With `triggerTurn: false`, the group notification is context-only and per-process wake settings remain active.
Use `listGroups` for a one-time progress check and `clearGroup` with `groupId` or `name` to remove a monitor.
If no independent work remains, end the turn and let notifications bring you back.

## Legacy tool compatibility

`kill` remains an alias for `stop`; intentional stops never wake the agent.
`logs` returns stdout, stderr and combined log file paths for the `read` tool.
Without `notify`, starts retain `alertOnSuccess: false`, `alertOnFailure: true` and `alertOnKill: false`.
Explicit `notify` retains upstream defaults; a supplied legacy alert flag overrides its corresponding attention field.
Use `alertOnSuccess: true` or `notify.onSuccess: "turn"` for a result that needs an immediate response.

Legacy `logWatches` use regular expressions, default to one match, and accept `stream` and `repeat`.
Legacy repeats match every matching line; current `notify.logMatches` repeats retain their cooldown.
Both formats use the same watch state and share the 20-watch limit.

`update` supports name and alert changes on running or finished records.
Use structured `logWatchUpdate` or its flat `watchAction` alias for `list`, `append`, `replace`, `remove` and `clear`.
Structured updates accept `watches`, `watchIndexes`, `replayTailLines` and `maxReplayMatches`.
Flat updates use `logWatches` instead of `watches`.
Do not combine a legacy watch update with the current `watches` format in one call.
Legacy `watchIndexes` are stable IDs returned in `legacyWatches`; current `watches.items[].index` values are current list positions.

```json
{
  "action": "update",
  "id": "proc_1",
  "alertOnSuccess": true,
  "logWatchUpdate": {
    "mode": "replace",
    "watches": [{ "pattern": "Ready|ERROR|FAIL", "stream": "both" }],
    "replayTailLines": 100,
    "maxReplayMatches": 20
  }
}
```

Replay scans a bounded tail of each stream for newly added watches only.
`replayTailLines` ranges from 0 to 10000, and `maxReplayMatches` from 0 to 200.
Replay returns matches in the update result without an extra asynchronous wake.
Matched once-only watches are marked as fired, so later output does not cause a duplicate wake.


## Actions

### `process start`

Starts a managed process.

Use it for dev servers, test watchers, build watchers, long-running log tails, local APIs, and other commands that should continue while the conversation moves on.

Good:

```json
{
  "action": "start",
  "name": "web-dev",
  "command": "pnpm dev",
  "cwd": "/path/to/project",
  "notify": {
    "onSuccess": "context",
    "onFailure": "turn",
    "logMatches": [
      { "pattern": "ready", "mode": "literal", "stream": "both" },
      { "pattern": "EADDRINUSE", "mode": "literal", "stream": "stderr", "on": "turn" }
    ]
  }
}
```

`onSuccess: "context"` here because a dev server exiting cleanly needs no immediate reaction; the result becomes context without waking you.
Set `notify.onSuccess: "turn"` or `alertOnSuccess: true` for builds, tests and other commands whose result you need immediately.

Optional `cwd` sets the working directory for the spawned command. Omit it to inherit the agent's current working directory.

Empty `logMatches` patterns (literal or regex) are rejected at start and update time. Use `mode: "regex"` only when literal matching is not enough, scope by `stream` to cut noise, and use `repeat: true` when a matcher should fire more than once.

Bad:

```bash
pnpm dev &
nohup pnpm dev >/tmp/dev.log 2>&1 &
```

### `process list`

Shows managed processes and log file paths.

Use it before `process start` when a duplicate process would be harmful or noisy. Do not repeat the visible process table back to the user unless you need to explain a decision.

Optional filters:

- `statuses`: `all`, `running`, `finished`, `failed`, `terminating`, `terminate_timeout`, `killed`
- `sortBy`: `startTime_desc`, `startTime_asc`, `name_asc`, `name_desc`, `status_asc`
- `limit`: maximum number of processes to return

Good:

```json
{ "action": "list", "statuses": ["running"] }
```

```json
{ "action": "list", "statuses": ["failed", "killed"], "sortBy": "startTime_desc", "limit": 10 }
```

Bad:

```text
Starting another dev server without checking whether one is already running.
```

### `process output`

Reads recent stdout/stderr from one process.

Use it for targeted checks, especially with `pattern` and `mode`. Do not use it as a polling loop. Do not use it for deep log inspection; use `read` on the stdout/stderr file paths instead.

Good:

```json
{
  "action": "output",
  "id": "proc_1",
  "stream": "stderr",
  "pattern": "EADDRINUSE",
  "mode": "literal"
}
```

Bad:

```text
Calling process output every few seconds waiting for "ready".
```

Use watches instead:

```json
{
  "action": "update",
  "id": "proc_1",
  "watches": {
    "mode": "append",
    "items": [{ "pattern": "ready", "mode": "literal" }]
  }
}
```

### `process update`

Renames a retained process or changes its watches and notification policy.
Finished records support metadata inspection and bounded replay until cleared.

Use it instead of restarting a process just to add, remove, or replace watch patterns. You can change `name` and `watches` in the same call.

`watches.mode` controls how the `items` are applied:

- `append` — add the items to the existing watches.
- `replace` — replace all watches with the items.
- `remove` — remove specific watches. Identify each by `index`, or by `pattern` (index takes precedence when both are given).
- `clear` — remove all watches. `items` is ignored.

Good:

```json
{
  "action": "update",
  "id": "proc_1",
  "name": "api-dev",
  "watches": {
    "mode": "append",
    "items": [
      { "pattern": "Server listening", "mode": "literal" },
      { "pattern": "EADDRINUSE", "mode": "literal", "stream": "stderr" }
    ]
  }
}
```

Bad:

```text
Stopping and restarting a server only to add a readiness matcher.
```

### `process write`

Sends bytes to a running process's stdin.

Use it to drive interactive servers, REPLs, and CLIs that expect input after they start. Pass `input` for the bytes to write, and set `end: true` to close stdin (for example to signal EOF to a waiting process).

Good:

```json
{ "action": "write", "id": "proc_1", "input": "quit\n" }
```

```json
{ "action": "write", "id": "proc_1", "end": true }
```

Bad:

```text
Writing with no `input` and no `end` (a no-op). The tool rejects it.
```

### `process stop`

Stops a managed process.

Use it when a process is obsolete, blocking a port, or no longer needed. Intentional stops suppress normal failure noise.

Good:

```json
{ "action": "stop", "id": "proc_1" }
```

### `process clear`

Clears finished processes and their log storage.

Use it after stopped, failed, or completed processes are no longer useful. It never clears live processes.

Good:

```json
{ "action": "clear" }
```

## Notification reference

`notify` on `process start` (and watches on `process update`) control how the manager brings you back.

Exit attention:

- `notify.onSuccess` — clean exit. Defaults to `turn`.
- `notify.onFailure` — failure or crash. Defaults to `turn`; `ignore` is downgraded to `context` because failures always notify.
- `notify.onKilled` — killed from outside the tool. Defaults to `context`. Intentional stops always produce context and bypass this setting.

Log match watches (`notify.logMatches`, up to 20, each pattern up to 500 chars):

- `pattern` — required. Literal by default; regex when `mode: "regex"`. Empty patterns are rejected.
- `mode` — `literal` (default) or `regex`.
- `stream` — `stdout`, `stderr`, or `both` (default). Scope to cut noise.
- `repeat` — `false` (default) fires once; `true` fires on every match.
- `on` — `turn`, `context`, or `ignore`. Overrides the default attention for that watch. Defaults to `turn`.

Attention levels:

- `turn` — wakes an idle agent or steers an active run at the next safe boundary.
- `context` — persisted immediately (mid-run, pi appends it after the current turn's tool results); it does not wake or steer the agent.
- `ignore` — suppresses successful-exit and external-kill notifications. Log matches are retained as context without waking the agent. Failure and crash notifications are also retained because failures always notify.

Use `context` when nothing needs to happen immediately.

## Use cases

### Dev server readiness

Start a server, get brought back when it prints its ready marker, then keep working.

```json
{
  "action": "start",
  "name": "web-dev",
  "command": "pnpm dev",
  "notify": {
    "logMatches": [{ "pattern": "ready", "stream": "stdout" }]
  }
}
```

You do not wait. End your turn; the watch fires and the manager brings you back.

### Test watcher failures

Keep a watcher running and react only when a test fails.

```json
{
  "action": "start",
  "name": "vitest-watch",
  "command": "pnpm test --watch",
  "notify": {
    "logMatches": [
      { "pattern": "FAIL", "stream": "stdout", "repeat": true, "on": "turn" },
      { "pattern": "Error:", "stream": "stderr", "repeat": true, "on": "turn" }
    ]
  }
}
```

### Build errors from stderr

Watch a build watcher and surface type or compile errors as they happen.

```json
{
  "action": "start",
  "name": "builder",
  "command": "pnpm build --watch",
  "notify": {
    "logMatches": [
      { "pattern": "TypeError|ReferenceError", "mode": "regex", "stream": "stderr", "repeat": true }
    ]
  }
}
```

### Repeatable progress markers

Fire on every job completion, not just the first.

```json
{
  "action": "start",
  "name": "worker",
  "command": "pnpm worker",
  "notify": {
    "logMatches": [{ "pattern": "job completed", "stream": "stdout", "repeat": true }]
  }
}
```

### Interactive process that needs stdin

Start a process that waits for input, drive it, then close stdin.

```json
{ "action": "start", "name": "customer-import", "command": "npm run import:customer" }
```

```json
{ "action": "write", "id": "proc_1", "input": "ALFKI\n", "end": true }
```

The process prints its result and exits; `onFailure`/`onSuccess` brings you back.

## When a log watch is too noisy

A watch that fires too often wastes turns. Fix it with `process update` — never restart the process just to change watches.

First, diagnose: is the pattern too broad, on the wrong stream, or repeating when it should fire once?

Then pick a `watches.mode`:

- **Tighten the pattern or scope the stream** — `replace` all watches with corrected ones.

```json
{
  "action": "update",
  "id": "proc_1",
  "watches": {
    "mode": "replace",
    "items": [{ "pattern": "EADDRINUSE", "stream": "stderr" }]
  }
}
```

- **Drop `repeat`** — if a `repeat: true` watch fires on every line, replace it with the same pattern and `repeat` omitted (defaults to `false`).

- **Remove one watch** — `remove` by `index` or `pattern`.

```json
{
  "action": "update",
  "id": "proc_1",
  "watches": {
    "mode": "remove",
    "items": [{ "pattern": "ready" }]
  }
}
```

```json
{
  "action": "update",
  "id": "proc_1",
  "watches": {
    "mode": "remove",
    "items": [{ "index": 0 }]
  }
}
```

- **Retain without interrupting** — set the watch's `on` to `ignore` so matches become context without interrupting the run.

```json
{
  "action": "update",
  "id": "proc_1",
  "watches": {
    "mode": "replace",
    "items": [{ "pattern": "job completed", "stream": "stdout", "repeat": true, "on": "ignore" }]
  }
}
```

- **Remove all watches** — `clear`.

```json
{
  "action": "update", "id": "proc_1", "watches": { "mode": "clear" } }
```

## Common mistakes

### Polling output instead of setting watches

Bad:

```text
Call process output repeatedly until the server is ready.
```

Good:

```json
{
  "action": "start",
  "name": "web-dev",
  "command": "pnpm dev",
  "notify": { "logMatches": [{ "pattern": "ready", "mode": "literal" }] }
}
```

### Waiting or sleeping after start

Bad:

```text
Start a dev server, then sleep or hold the turn until it is ready.
```

Good:

```text
Start the server with a "ready" watch and end the turn. The watch brings you back.
```

### Restarting instead of updating watches

Bad:

```text
Stop and restart a process because you forgot to watch for EADDRINUSE, or because a watch is too noisy.
```

Good:

```json
{
  "action": "update",
  "id": "proc_1",
  "watches": {
    "mode": "append",
    "items": [{ "pattern": "EADDRINUSE", "stream": "stderr" }]
  }
}
```

### Starting duplicates

Bad:

```text
Start `pnpm dev` without checking existing process state.
```

Good:

```json
{ "action": "list", "statuses": ["running"] }
```

Then start only if needed.

### Missing common failure watches

When starting servers, consider watches for readiness and common failure signals:

- `ready`
- `listening`
- `compiled`
- `EADDRINUSE`
- `Error:`
- `UnhandledPromiseRejection`

Keep watch patterns specific enough to avoid noisy false positives.

### Re-summarizing visible tool output

Bad:

```text
The process list shows proc_1 is running, proc_2 exited, and proc_3 failed...
```

Good:

```text
I'll reuse the existing `web-dev` process.
```

### Using vague names

Bad names:

- `server`
- `test`
- `watch`

Good names:

- `web-dev`
- `api-dev`
- `vitest-watch`
- `tail-app-logs`

### Leaving obsolete processes running

Stop live processes that are no longer useful, especially duplicate dev servers or commands occupying ports. Clear finished entries when they are no longer needed for debugging.

## UI commands

Users can inspect and control processes with:

- `/ps` for overview and control.
- `/ps:logs` for focused logs.
- `/ps:dock` and `/ps:pin` when the dock extension is loaded.
- `/ps:kill` to stop a running process.
- `/ps:clear` to remove finished entries.
- `/ps:settings` for package settings.

Do not ask the user to start long-running commands manually. If a process needs to run, use the `process` tool.
