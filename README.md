![banner](https://assets.aliou.me/pi-extensions/banners/pi-processes.png)

# pi-processes

Manage background processes from Pi without blocking the conversation.

This extension lets Pi keep long-running commands alive while the conversation continues. It is useful for dev servers, test watchers, local APIs, builds, and log tails.

## Let Pi keep working while processes run

When a task needs a long-running command, Pi can start it in the background by itself and keep helping with the rest of the work.

That means Pi can, for example:

- start a dev server and keep coding
- keep a test watcher running while it fixes failures
- run a local API while it inspects logs
- watch build output without blocking the conversation

You can then inspect, pin, or stop those processes from the UI.

<!-- VIDEO: {"id":"agent-starts-processes","title":"Pi starts a long-running process and keeps working"} -->

## Installation

From npm:

```bash
pi install npm:@aliou/pi-processes
```

From git:

```bash
pi install git:github.com/aliou/pi-processes
```

## Open the process panel

Use `/ps` to open the main process panel.

From there you can:

- see running and finished processes
- see active watch and alert indicators on monitored processes
- inspect recent output
- pin a process to the dock
- kill a running process
- clear finished entries

Keys:

- `j/k` or arrow keys: move selection
- `J/K`: scroll preview
- `enter`: pin selected process to the dock
- `x`: kill selected process
- `c`: clear finished processes
- `q` or `esc`: close

<!-- VIDEO: {"id":"process-panel","title":"Browse and manage processes from the panel"} -->

## Inspect logs

Use `/ps:logs [id|name]` to open the log overlay for one process.

This is useful when Pi started a server, watcher, or local API and you want to follow what it is doing in more detail.

Keys:

- `tab` / `shift+tab`: switch process tabs
- `g/G`: jump to top or bottom
- `j/k` or arrow keys: scroll
- `s`: switch between combined, stdout, and stderr
- `f`: toggle follow mode
- `/`: search
- `n/N`: move between search matches
- `q` or `esc`: close

<!-- VIDEO: {"id":"inspect-logs","title":"Open the log overlay and inspect output"} -->

## Pin one process

Use `/ps:pin [id|name]` to keep the dock focused on one process.

This is useful when one process matters more than the others, such as a dev server or a test watcher.

Without arguments, Pi shows a picker.

<!-- VIDEO: {"id":"pin-process","title":"Pin the dock to one process"} -->

## Control the dock

Use `/ps:dock [show|hide|toggle]` to control dock visibility.

The dock gives you a compact live view without leaving the conversation.

<!-- VIDEO: {"id":"dock-control","title":"Show, hide, and use the dock"} -->

## Adjust settings

Use `/ps:settings` to configure the extension.

Available settings include:

- process list size
- output limits
- shell path override
- dock defaults
- follow mode behavior
- optional background command interception

<!-- VIDEO: {"id":"settings","title":"Adjust process extension settings"} -->

## Platform support

- macOS: supported
- Linux: supported
- Windows: not supported

## Runtime log watch alerts

Use `process` tool `start` with `logWatches` to trigger immediate alerts while the process is still running.

- default behavior: each watch fires once (`repeat: false`)
- set `repeat: true` to trigger on every match
- scope by stream (`stdout`, `stderr`, `both`) to reduce noise

Example: server ready marker (one-time default)

```json
{
  "action": "start",
  "name": "dev-server",
  "command": "pnpm dev",
  "logWatches": [
    { "pattern": "ready on http://localhost:3000" }
  ]
}
```

Example: error marker from stderr

```json
{
  "action": "start",
  "name": "builder",
  "command": "pnpm build --watch",
  "logWatches": [
    { "pattern": "TypeError|ReferenceError", "stream": "stderr" }
  ]
}
```

Example: repeatable watch on stdout only

```json
{
  "action": "start",
  "name": "worker",
  "command": "pnpm worker",
  "logWatches": [
    { "pattern": "job completed", "stream": "stdout", "repeat": true }
  ]
}
```

Invalid regex patterns fail fast at process start with a clear error.

If Pi starts a long-running process with missing, noisy, or incorrect watches, it can update the process metadata later without restarting the process. The `process` tool `update` action can change alert flags and list, append, replace, remove, or clear log watches. When adding or replacing watches after output may have already passed the relevant marker, Pi can use `replayTailLines` to scan a small tail of recent output once. Replay is intentionally bounded: `replayTailLines` must be at most `10000`, and `maxReplayMatches` must be at most `200`.

Agents should not run `sleep`, timeout-wrapped `sleep`, or shell wait loops just to give a managed process time. If completion or a marker matters, start or update the process with `alertOnSuccess`, `alertOnFailure`, `logWatches`, or a process group monitor; then continue other work, or stop the turn and let the notification bring the agent back.

When an external async system has its own watch command, Pi should run that watch command as a managed process instead of polling the service from the agent. The provider CLI owns remote status transitions; `pi-processes` owns non-blocking monitoring, output capture, and lifecycle notification.

Example: watch a GitHub Actions run until it succeeds or fails

```json
{
  "action": "start",
  "name": "watch-main-ci-before-release",
  "command": "gh run watch 25127985114 --exit-status",
  "alertOnSuccess": true,
  "alertOnFailure": true
}
```

Example: replace noisy watches and replay recent output

```json
{
  "action": "update",
  "id": "proc_1",
  "alertOnSuccess": true,
  "logWatchUpdate": {
    "mode": "replace",
    "watches": [
      { "pattern": "Ready|ERROR|FAIL", "stream": "both", "repeat": true }
    ],
    "replayTailLines": 100
  }
}
```

## Aggregate process monitors

Use `monitorGroup` when several managed processes belong to one workflow and the agent needs one aggregate notification instead of sleeping or polling.

- `groupMode: "all"` is for WhenAll-style workflows. It notifies when all processes exit, and `failFast` defaults to `true` so the group notifies on the first failed or killed process.
- `groupMode: "any"` is for WhenAny-style workflows. It notifies when the first process exits.
- `triggerTurn` defaults to `true`; set it to `false` only when the UI notification is enough and the agent does not need to react. With `triggerTurn: true`, the group owns lifecycle follow-up turns for member processes so Pi avoids duplicate per-process completion/failure turns.

Example: monitor a profiling suite until all succeed or one fails

```json
{
  "action": "monitorGroup",
  "name": "profile-suite",
  "processIds": ["proc_1", "proc_2", "proc_3"],
  "groupMode": "all",
  "failFast": true
}
```

Example: monitor the first result from several alternatives

```json
{
  "action": "monitorGroup",
  "name": "first-profile-result",
  "processIds": ["proc_1", "proc_2", "proc_3"],
  "groupMode": "any"
}
```

Use `listGroups` to inspect group progress and `clearGroup` with a group ID or name when the monitor is no longer useful.

## Troubleshooting

### Pi started something and I want to see more output

Open `/ps` for a quick overview, or use `/ps:logs` for full logs.

### I want one process to stay visible

Use `/ps:pin` to focus the dock on that process.

### I want Pi to avoid shell background tricks

Enable background command interception in `/ps:settings`. When enabled, Pi avoids normal shell background patterns and uses the process workflow instead.

## Contributing

For development, testing, docs generation, and extension internals, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT