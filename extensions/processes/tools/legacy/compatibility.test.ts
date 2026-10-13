import { EventEmitter } from "node:events";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessManager } from "../../../../src/manager";
import { GroupMonitors } from "../../../../src/manager/group-monitors";
import type { ManagerEvent, ProcessInfo } from "../../../../src/types";
import {
  CHANNELS,
  type ProcessProtocolNotificationPayload,
} from "../../../shared/protocol";
import { registerNotificationDelivery } from "../../handlers/notifications";
import { createNotificationRegistry } from "../../notifications/registry";
import { createNotificationService } from "../../notifications/service";
import { registerProcessTool } from "../index";
import { executeList, formatListDetails } from "../list";
import { executeOutput } from "../output";
import type { ProcessesParamsType } from "../schema";
import { executeStart } from "../start";
import { executeUpdate, formatUpdateDetails } from "../update";

const ctx = {
  cwd: "/repo",
  sessionManager: {
    getSessionId: () => "session",
    getSessionFile: () => undefined,
  },
} as ExtensionToolContext;
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function fixture() {
  const processes = new Map<string, ProcessInfo>();
  const history = new Map<
    string,
    Array<{ type: "stdout" | "stderr"; text: string }>
  >();
  const emitter = new EventEmitter();
  function emit(event: ManagerEvent) {
    emitter.emit("event", event);
    if (event.type === "process_ended") groups.update(event.info.id);
  }
  const groups = new GroupMonitors((id) => processes.get(id) ?? null, emit);
  const manager = {
    onEvent(listener: (event: ManagerEvent) => void) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
    get(id: string) {
      const info = processes.get(id);
      return info ? { ...info } : null;
    },
    list() {
      return [...processes.values()];
    },
    rename(id: string, name: string) {
      const info = processes.get(id);
      if (!info) return null;
      info.name = name;
      return { ...info };
    },
    start(name: string, command: string, cwd: string) {
      const info: ProcessInfo = {
        id: `proc_${processes.size}`,
        name,
        command,
        cwd,
        pid: 123,
        startTime: Date.now(),
        endTime: null,
        status: "running",
        exitCode: null,
        success: null,
        stdoutFile: "stdout.log",
        stderrFile: "stderr.log",
        signal: null,
        endReason: null,
        errorMessage: null,
      };
      processes.set(info.id, info);
      return { ...info };
    },
    getOutput(id: string, tailLines: number) {
      const lines = history.get(id) ?? [];
      return {
        stdout: lines
          .filter((line) => line.type === "stdout")
          .map((line) => line.text)
          .slice(-tailLines),
        stderr: lines
          .filter((line) => line.type === "stderr")
          .map((line) => line.text)
          .slice(-tailLines),
        status: processes.get(id)?.status ?? "running",
      };
    },
    getLogFiles() {
      return {
        stdoutFile: "stdout.log",
        stderrFile: "stderr.log",
        combinedFile: "combined.log",
      };
    },
    hasTurnGroupForProcess(id: string) {
      return groups.hasTurnGroupForProcess(id);
    },
    monitorGroup: groups.monitor.bind(groups),
    listGroups: groups.list.bind(groups),
    clearGroup: groups.clear.bind(groups),
    kill: vi.fn(async (id: string) => {
      end(id, false, "killed");
      return { ok: true, info: processes.get(id) };
    }),
  } as unknown as ProcessManager;
  const registry = createNotificationRegistry();
  const events = createEventBus();
  const emitted: ProcessProtocolNotificationPayload[] = [];
  events.on(CHANNELS.NOTIFICATION, (payload) =>
    emitted.push(payload as ProcessProtocolNotificationPayload),
  );
  const service = createNotificationService({
    events,
    manager,
    registry,
    getProcess: (id) => manager.get(id),
  });
  disposers.push(() => service.dispose());
  function start(params: Partial<ProcessesParamsType> = {}) {
    return executeStart(
      { action: "start", name: "test", command: "cat", ...params },
      manager,
      ctx,
      registry,
    ).process;
  }
  function end(
    id: string,
    success = true,
    status: ProcessInfo["status"] = "exited",
  ) {
    const info = processes.get(id);
    if (!info) throw new Error("missing fixture process");
    Object.assign(info, {
      success,
      status,
      endTime: Date.now(),
      exitCode: success ? 0 : 1,
      endReason: "exit",
    });
    emit({ type: "process_ended", info: { ...info } });
  }
  function output(
    id: string,
    text: string,
    type: "stdout" | "stderr" = "stdout",
  ) {
    const lines = history.get(id) ?? [];
    lines.push({ type, text });
    history.set(id, lines);
    emit({
      type: "process_output_changed",
      id,
      appendedText: [{ type, text }],
    });
  }
  function update(id: string, params: Partial<ProcessesParamsType>) {
    return executeUpdate(
      { action: "update", id, ...params },
      manager,
      registry,
    );
  }
  return {
    manager,
    registry,
    events,
    emitted,
    start,
    end,
    output,
    update,
    history,
    emit,
    processes,
    groups,
  };
}

async function flush() {
  await Promise.resolve();
}

describe("legacy and current process API interoperability", () => {
  it.each([
    { success: true, status: "exited", attention: "context" },
    { success: false, status: "exited", attention: "turn" },
    { success: false, status: "killed", attention: "context" },
  ] as const)(
    "preserves omitted alert defaults for $status/$success",
    async ({ success, status, attention }) => {
      const f = fixture();
      const info = f.start();
      f.end(info.id, success, status);
      await flush();
      expect(f.emitted).toHaveLength(1);
      expect(f.emitted[0].attention).toBe(attention);
    },
  );

  it("retains notify defaults and permits explicit legacy alerts to override them", async () => {
    const f = fixture();
    const current = f.start({ notify: {} });
    f.end(current.id);
    await flush();
    expect(f.emitted[0].attention).toBe("turn");
    const legacy = f.start({
      notify: { onFailure: "turn" },
      alertOnFailure: false,
    });
    f.end(legacy.id, false);
    await flush();
    expect(f.emitted[1].attention).toBe("context");
  });

  it("applies updated external-kill alert policy", async () => {
    const f = fixture();
    const info = f.start();
    f.update(info.id, { alertOnKill: true });
    f.end(info.id, false, "killed");
    await flush();
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0].attention).toBe("turn");
  });

  it("updates live alert metadata without losing watches or rearming once-only state", async () => {
    const f = fixture();
    const info = f.start({ logWatches: [{ pattern: "^ready$" }] });
    f.output(info.id, "ready");
    const details = f.update(info.id, {
      name: "renamed",
      alertOnSuccess: true,
      alertOnFailure: false,
      alertOnKill: true,
      watchAction: "list",
    });
    expect(details.process?.name).toBe("renamed");
    expect(details.legacyWatches?.[0].fired).toBe(true);
    f.output(info.id, "ready");
    expect(f.emitted.filter((item) => item.kind === "log_match")).toHaveLength(
      1,
    );
    f.end(info.id);
    await flush();
    expect(f.emitted.at(-1)?.attention).toBe("turn");
  });

  it("shares regex legacy watches and literal current watches with fired-state preservation", () => {
    const f = fixture();
    const info = f.start({ logWatches: [{ pattern: "^ready$" }] });
    f.output(info.id, "not ready yet");
    expect(f.emitted).toHaveLength(0);
    f.output(info.id, "ready");
    f.update(info.id, {
      watches: {
        mode: "append",
        items: [{ pattern: "error[1]", on: "context" }],
      },
    });
    f.output(info.id, "ready");
    f.output(info.id, "error[1]");
    expect(f.emitted).toHaveLength(2);
    expect(f.emitted[1]).toMatchObject({
      kind: "log_match",
      attention: "context",
      logMatch: { mode: "literal" },
    });
    const listed = f.update(info.id, { logWatchUpdate: { mode: "list" } });
    expect(listed.legacyWatches?.map((watch) => watch.fired)).toEqual([
      true,
      true,
    ]);
    f.update(info.id, { watchAction: "remove", watchIndexes: [0] });
    expect(f.registry.getWatchInfo(info.id)[0]).toMatchObject({
      index: 1,
      pattern: "error[1]",
      fired: true,
    });
    f.update(info.id, { watchAction: "clear" });
    expect(f.registry.getWatchInfo(info.id)).toEqual([]);
  });

  it("replays only added watches once and does not skip a later matcher under the match cap", () => {
    const f = fixture();
    const info = f.start({ logWatches: [{ pattern: "^old$" }] });
    f.output(info.id, "old");
    f.output(info.id, "ready");
    const details = f.update(info.id, {
      logWatchUpdate: {
        mode: "append",
        watches: [{ pattern: "never" }, { pattern: "^ready$" }],
        replayTailLines: 10,
        maxReplayMatches: 1,
      },
    });
    expect(details.replayMatches).toEqual([
      { watchIndex: 2, pattern: "^ready$", source: "stdout", line: "ready" },
    ]);
    expect(f.emitted).toHaveLength(1);
    f.output(info.id, "ready");
    expect(f.emitted).toHaveLength(1);
    const replaced = f.update(info.id, {
      watchAction: "replace",
      logWatches: [{ pattern: "^ready$" }],
      replayTailLines: 10,
    });
    expect(replaced.replayMatches).toHaveLength(1);
    expect(f.emitted).toHaveLength(1);
  });

  it("limits replay to the requested tail and selected streams without mutating skipped watches", () => {
    const f = fixture();
    const info = f.start();
    f.output(info.id, "old");
    f.output(info.id, "ready");
    f.output(info.id, "unrelated");
    f.output(info.id, "error", "stderr");
    const details = f.update(info.id, {
      watchAction: "replace",
      logWatches: [
        { pattern: "old" },
        { pattern: "ready", stream: "stderr" },
        { pattern: "error", stream: "stderr" },
      ],
      replayTailLines: 2,
    });
    expect(details.replayMatches).toHaveLength(1);
    expect(details.legacyWatches?.map((watch) => watch.fired)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("keeps legacy watch identifiers stable across remove, replace and clear while modern indexes stay positional", () => {
    const f = fixture();
    const info = f.start({
      logWatches: [{ pattern: "first" }, { pattern: "second" }],
    });
    f.update(info.id, { watchAction: "remove", watchIndexes: [0] });
    expect(f.registry.getWatchInfo(info.id)[0].index).toBe(1);
    f.update(info.id, { watchAction: "remove", watchIndexes: [0] });
    expect(f.registry.getWatchInfo(info.id)).toHaveLength(1);
    f.update(info.id, {
      watchAction: "replace",
      logWatches: [{ pattern: "third" }],
    });
    expect(f.registry.getWatchInfo(info.id)[0].index).toBe(2);
    f.update(info.id, { watchAction: "remove", watchIndexes: [1] });
    expect(f.registry.getWatchInfo(info.id)).toHaveLength(1);
    f.update(info.id, { watches: { mode: "remove", items: [{ index: 0 }] } });
    expect(f.registry.getWatchInfo(info.id)).toEqual([]);
    f.update(info.id, {
      watchAction: "append",
      logWatches: [{ pattern: "fourth" }],
    });
    expect(f.registry.getWatchInfo(info.id)[0].index).toBe(3);
  });

  it.each(["legacy", "current"] as const)(
    "preserves each %s one-shot watch when an older identical watch is removed",
    (api) => {
      const f = fixture();
      let info: ProcessInfo;
      if (api === "legacy") {
        info = f.start({ logWatches: [{ pattern: "^ready$" }] });
      } else {
        info = f.start({
          notify: { logMatches: [{ pattern: "ready", on: "turn" }] },
        });
      }
      f.output(info.id, "ready");
      if (api === "legacy") {
        f.update(info.id, {
          watchAction: "append",
          logWatches: [{ pattern: "^ready$" }],
        });
      } else {
        f.update(info.id, {
          watches: {
            mode: "append",
            items: [{ pattern: "ready", on: "turn" }],
          },
        });
      }
      expect(
        f.registry.getWatchInfo(info.id).map((watch) => watch.fired),
      ).toEqual([true, false]);
      if (api === "legacy") {
        f.update(info.id, { watchAction: "remove", watchIndexes: [0] });
      } else {
        f.update(info.id, {
          watches: { mode: "remove", items: [{ index: 0 }] },
        });
      }
      expect(f.registry.getWatchInfo(info.id)).toMatchObject([
        { index: 1, fired: false },
      ]);
      f.output(info.id, "ready");
      f.output(info.id, "ready");
      expect(
        f.emitted.filter((notification) => notification.kind === "log_match"),
      ).toHaveLength(2);
      expect(f.registry.getWatchInfo(info.id)).toMatchObject([
        { index: 1, fired: true },
      ]);
    },
  );

  it("legacy repeats match every line, while replay returns matches without extra turns or live cooldown", () => {
    const f = fixture();
    const info = f.start();
    f.output(info.id, "ready");
    f.output(info.id, "ready");
    const replay = f.update(info.id, {
      watchAction: "append",
      logWatches: [{ pattern: "ready", repeat: true }],
      replayTailLines: 10,
    });
    expect(replay.replayMatches).toHaveLength(2);
    expect(f.emitted).toHaveLength(0);
    f.output(info.id, "ready\nready");
    expect(f.emitted).toHaveLength(2);
    const zero = f.update(info.id, {
      watchAction: "replace",
      logWatches: [{ pattern: "ready" }],
      replayTailLines: 10,
      maxReplayMatches: 0,
    });
    expect(zero.replayMatches).toEqual([]);
    expect(zero.legacyWatches?.[0].fired).toBe(false);
    f.output(info.id, "ready");
    expect(f.emitted).toHaveLength(3);
  });

  it("rejects invalid regex, replay bounds, and watcher overflow before metadata mutation", () => {
    const f = fixture();
    const info = f.start({
      logWatches: Array.from({ length: 20 }, (_, index) => ({
        pattern: `marker${index}`,
      })),
    });
    expect(() =>
      f.update(info.id, {
        name: "bad",
        logWatchUpdate: { mode: "replace", watches: [{ pattern: "[" }] },
      }),
    ).toThrow(/regular expression/);
    expect(() =>
      f.update(info.id, {
        name: "bad",
        watchAction: "replace",
        logWatches: [{ pattern: "ready" }],
        replayTailLines: 10001,
      }),
    ).toThrow(/replayTailLines/);
    expect(() =>
      f.update(info.id, {
        name: "bad",
        watches: { mode: "append", items: [{ pattern: "extra" }] },
      }),
    ).toThrow(/maximum/);
    expect(() =>
      f.update(info.id, {
        name: "bad",
        watches: { mode: "remove", items: [{ pattern: "[", mode: "regex" }] },
      }),
    ).toThrow(/regular expression/);
    expect(f.manager.get(info.id)?.name).toBe("test");
    expect(f.registry.getWatchState(info.id)?.logMatches).toHaveLength(20);
  });

  it("allows finished metadata and replay, then drops archived state when the record is cleared", async () => {
    const f = fixture();
    const info = f.start({
      alertOnSuccess: true,
      logWatches: [{ pattern: "ready" }],
    });
    f.output(info.id, "ready");
    f.output(info.id, "done");
    f.end(info.id);
    await flush();
    const details = f.update(info.id, {
      name: "finished",
      watchAction: "append",
      logWatches: [{ pattern: "done" }],
      replayTailLines: 10,
    });
    expect(details.ok).toBe(true);
    expect(details.replayMatches).toHaveLength(1);
    expect(details.notify?.onSuccess).toBe("turn");
    expect(details.legacyWatches?.[0].fired).toBe(true);
    f.processes.delete(info.id);
    f.emit({ type: "processes_changed" });
    expect(f.registry.get(info.id)).toBeNull();
    f.registry.restore(info.id);
    expect(f.registry.get(info.id)).toBeNull();
  });

  it.each(["all", "any"] as const)(
    "group-owned %s notifications suppress duplicate member turns, not watch turns",
    async (mode) => {
      const f = fixture();
      const first = f.start({
        alertOnSuccess: true,
        logWatches: [{ pattern: "ready" }],
      });
      const second = f.start({ alertOnSuccess: true });
      f.manager.monitorGroup("jobs", [first.id, second.id], { mode });
      f.output(first.id, "ready");
      f.end(first.id);
      await flush();
      f.end(second.id);
      await flush();
      expect(
        f.emitted.filter((item) => item.kind === "group_monitor"),
      ).toHaveLength(1);
      expect(
        f.emitted
          .filter((item) => item.attention === "turn")
          .map((item) => item.kind),
      ).toEqual(["log_match", "group_monitor"]);
      expect(
        f.emitted
          .filter((item) => item.kind === "success")
          .map((item) => item.attention),
      ).toEqual(["context", "context"]);
    },
  );

  it("already-settled registration owns member notifications that have not been delivered yet", async () => {
    const f = fixture();
    const info = f.start({ alertOnSuccess: true });
    f.end(info.id);
    f.manager.monitorGroup("settled", [info.id]);
    await flush();
    expect(f.emitted.map((item) => [item.kind, item.attention])).toEqual([
      ["group_monitor", "turn"],
      ["success", "context"],
    ]);
  });

  it("clearing after the end event does not create a duplicate member wake", async () => {
    const f = fixture();
    const info = f.start({ alertOnSuccess: true });
    f.manager.monitorGroup("jobs", [info.id]);
    f.end(info.id);
    f.manager.clearGroup("jobs");
    await flush();
    expect(f.emitted.map((item) => [item.kind, item.attention])).toEqual([
      ["group_monitor", "turn"],
      ["success", "context"],
    ]);
  });

  it("fail-fast ownership persists until cleared and context groups leave member turns active", async () => {
    const f = fixture();
    const first = f.start();
    const second = f.start({ alertOnSuccess: true });
    f.manager.monitorGroup("jobs", [first.id, second.id]);
    f.end(first.id, false);
    await flush();
    f.manager.clearGroup("jobs");
    f.manager.monitorGroup("context", [second.id], { triggerTurn: false });
    f.end(second.id);
    await flush();
    expect(f.emitted.map((item) => [item.kind, item.attention])).toEqual([
      ["group_monitor", "turn"],
      ["crash", "context"],
      ["group_monitor", "context"],
      ["success", "turn"],
    ]);
  });

  it("delivers only one idle-host wake for a complete aggregate and retains member messages as context", async () => {
    const f = fixture();
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const pi = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      }),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    disposers.push(registerNotificationDelivery(f.events, pi));
    handlers.get("session_start")?.({}, { isIdle: () => true });
    const first = f.start({ alertOnSuccess: true });
    const second = f.start({ alertOnSuccess: true });
    f.manager.monitorGroup("jobs", [first.id, second.id]);
    f.end(first.id);
    await flush();
    f.end(second.id);
    await flush();
    expect(pi.sendMessage).toHaveBeenCalledTimes(3);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("tool dispatch keeps kill/logs and all group actions operable with structured results", async () => {
    const f = fixture();
    const pi = { registerTool: vi.fn() } as unknown as ExtensionAPI;
    registerProcessTool(pi, f.manager, f.registry);
    const tool = vi.mocked(pi.registerTool).mock.calls[0][0];
    const info = f.start({ alertOnKill: true });
    const call = (params: ProcessesParamsType) =>
      tool.execute("test", params, undefined, undefined, ctx);
    const logs = await call({ action: "logs", id: info.id });
    expect(logs.structuredContent).toMatchObject({
      action: "logs",
      logFiles: { combinedFile: "combined.log" },
    });
    const group = await call({
      action: "monitorGroup",
      name: "jobs",
      processIds: [info.id],
    });
    expect(group.structuredContent).toMatchObject({
      action: "monitorGroup",
      success: true,
    });
    const listed = await call({ action: "listGroups" });
    expect(listed.structuredContent).toMatchObject({
      groups: [{ name: "jobs" }],
    });
    const cleared = await call({ action: "clearGroup", name: "jobs" });
    expect(cleared.structuredContent).toMatchObject({ success: true });
    const killed = await call({ action: "kill", id: info.id });
    expect(killed.structuredContent).toMatchObject({
      action: "stop",
      result: { ok: true },
    });
    await flush();
    expect(f.emitted.at(-1)?.attention).toBe("context");
  });

  it("keeps policy and fired watch state inspectable in list and output without restoring live subscriptions", async () => {
    const f = fixture();
    const info = f.start({
      alertOnSuccess: true,
      logWatches: [{ pattern: "ready" }],
    });
    f.output(info.id, "ready");
    f.end(info.id);
    await flush();
    const listed = executeList(f.manager, { action: "list" }, f.registry);
    expect(listed.processes[0].notify?.onSuccess).toBe("turn");
    expect(listed.processes[0].legacyWatches?.[0]).toMatchObject({
      index: 0,
      fired: true,
    });
    expect(formatListDetails(listed)).toContain('"onSuccess":"turn"');
    const output = executeOutput(
      { action: "output", id: info.id },
      f.manager,
      f.registry,
    );
    expect(output.details.notify?.onSuccess).toBe("turn");
    expect(output.details.legacyWatches?.[0].fired).toBe(true);
    expect(f.registry.getWatchState(info.id)).toBeNull();
    f.output(info.id, "ready");
    expect(f.emitted).toHaveLength(2);
  });

  it("formats watch listing and replay as model-visible metadata", () => {
    const f = fixture();
    const info = f.start({ logWatches: [{ pattern: "ready" }] });
    const details = f.update(info.id, { watchAction: "list" });
    expect(formatUpdateDetails(details)).toContain("ready");
  });
});
