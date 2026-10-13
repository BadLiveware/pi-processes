import { describe, expect, it } from "vitest";
import type { ManagerEvent, ProcessInfo } from "../types";
import {
  GroupMonitors,
  MAX_GROUP_MONITORS,
  MAX_GROUP_PROCESS_IDS,
} from "./group-monitors";

function fixture() {
  const processes = new Map<string, ProcessInfo>();
  const events: ManagerEvent[] = [];
  const groups = new GroupMonitors(
    (id) => processes.get(id) ?? null,
    (event) => events.push(event),
  );
  function add(
    id: string,
    status: ProcessInfo["status"] = "running",
    success: boolean | null = null,
  ) {
    const info: ProcessInfo = {
      id,
      name: id,
      command: "cat",
      cwd: "/tmp",
      pid: 1,
      startTime: 1,
      endTime: null,
      status,
      exitCode: null,
      success,
      stdoutFile: "stdout",
      stderrFile: "stderr",
      endReason: null,
      signal: null,
      errorMessage: null,
    };
    processes.set(id, info);
    return info;
  }
  function settle(
    id: string,
    success = true,
    status: ProcessInfo["status"] = "exited",
  ) {
    const info = processes.get(id);
    if (!info) throw new Error("missing fixture process");
    info.status = status;
    info.success = success;
    info.endTime = Date.now();
    groups.update(id);
  }
  function notifications() {
    return events.filter(
      (event) => event.type === "process_group_monitor_triggered",
    );
  }
  add("first");
  add("second");
  return { groups, processes, events, add, settle, notifications };
}

describe("aggregate group monitors", () => {
  it("notifies once when all members complete successfully", () => {
    const f = fixture();
    expect(f.groups.monitor("builds", ["first", "second"]).ok).toBe(true);
    f.settle("first");
    expect(f.notifications()).toHaveLength(0);
    expect(f.groups.list()[0].summary).toMatchObject({
      running: 1,
      succeeded: 1,
    });
    f.settle("second");
    f.groups.update("second");
    expect(f.notifications()).toHaveLength(1);
    expect(f.groups.list()[0]).toMatchObject({
      outcome: "all_succeeded",
      summary: { running: 0, succeeded: 2 },
    });
  });

  it.each(["exited", "killed"] as const)(
    "fails fast on a %s member and owns later member wakes",
    (status) => {
      const f = fixture();
      f.groups.monitor("jobs", ["first", "second"]);
      f.settle("first", false, status);
      expect(f.notifications()).toHaveLength(1);
      expect(f.groups.list()[0]).toMatchObject({
        outcome: "any_failed",
        triggerProcessId: "first",
        summary: { running: 1 },
      });
      expect(f.groups.hasTurnGroupForProcess("second")).toBe(true);
      expect(f.groups.retains("first")).toBe(true);
      f.settle("second");
      expect(f.notifications()).toHaveLength(1);
      expect(f.groups.retains("first")).toBe(false);
    },
  );

  it("waits for all outcomes when failFast is false", () => {
    const f = fixture();
    f.groups.monitor("jobs", ["first", "second"], { failFast: false });
    f.settle("first", false);
    expect(f.notifications()).toHaveLength(0);
    expect(f.groups.retains("first")).toBe(true);
    f.settle("second");
    expect(f.groups.list()[0].outcome).toBe("all_exited");
  });

  it("any-mode notifies once without dropping ownership of remaining members", () => {
    const f = fixture();
    f.groups.monitor("race", ["first", "second"], { mode: "any" });
    f.settle("second");
    f.settle("first", false);
    expect(f.notifications()).toHaveLength(1);
    expect(f.groups.list()[0]).toMatchObject({
      outcome: "any_succeeded",
      triggerProcessId: "second",
      failFast: false,
    });
    expect(f.groups.hasTurnGroupForProcess("first")).toBe(true);
  });

  it("context-only groups do not suppress member wakes", () => {
    const f = fixture();
    f.groups.monitor("context", ["first"], { triggerTurn: false });
    expect(f.groups.hasTurnGroupForProcess("first")).toBe(false);
    f.settle("first");
    expect(f.notifications()[0].group.triggerTurn).toBe(false);
  });

  it("clearing by name or id releases wake ownership and pending retention", () => {
    const f = fixture();
    const result = f.groups.monitor("jobs", ["first", "second"]);
    if (!result.ok) throw new Error(result.message);
    f.settle("first");
    expect(f.groups.clear(" jobs ").ok).toBe(true);
    expect(f.groups.hasTurnGroupForProcess("second")).toBe(false);
    expect(f.groups.retains("first")).toBe(false);
    f.settle("second");
    expect(f.notifications()).toHaveLength(0);
    f.groups.monitor("again", ["first"]);
    expect(f.groups.clear(f.groups.list()[0].id).ok).toBe(true);
    expect(f.groups.clear(result.group.id).ok).toBe(false);
  });

  it.each(["all", "any"] as const)(
    "immediately evaluates already settled %s-mode members",
    (mode) => {
      const f = fixture();
      f.settle("first");
      f.settle("second");
      const result = f.groups.monitor("settled", ["first", "second"], { mode });
      expect(result.ok).toBe(true);
      expect(f.notifications()).toHaveLength(1);
      expect(f.groups.list()[0].triggeredAt).not.toBeNull();
      f.groups.update("first");
      expect(f.notifications()).toHaveLength(1);
    },
  );

  it("deduplicates member ids and returns immutable snapshots", () => {
    const f = fixture();
    const result = f.groups.monitor("jobs", ["first", " first ", "second"]);
    if (!result.ok) throw new Error(result.message);
    result.group.processIds.length = 0;
    result.group.summary.running = 100;
    expect(f.groups.list()[0].processIds).toEqual(["first", "second"]);
    expect(f.groups.list()[0].summary.running).toBe(2);
  });

  it("retains timed-out members as live, rather than announcing success", () => {
    const f = fixture();
    f.groups.monitor("jobs", ["first", "second"]);
    f.settle("first", false, "terminate_timeout");
    f.settle("second");
    expect(f.notifications()).toHaveLength(0);
    expect(f.groups.list()[0].summary.running).toBe(1);
  });

  it("removes settled monitors when their retained records are removed", () => {
    const f = fixture();
    f.groups.monitor("jobs", ["first"]);
    f.settle("first");
    f.groups.removeReferences("first");
    expect(f.groups.list()).toEqual([]);
  });

  it("rejects empty, missing, and excessive groups without registering partial state", () => {
    const f = fixture();
    expect(f.groups.monitor("", ["first"]).ok).toBe(false);
    expect(f.groups.monitor("empty", []).ok).toBe(false);
    expect(f.groups.monitor("missing", ["unknown"]).ok).toBe(false);
    const ids = Array.from(
      { length: MAX_GROUP_PROCESS_IDS + 1 },
      (_, index) => `extra${index}`,
    );
    for (const id of ids) f.add(id);
    expect(f.groups.monitor("large", ids).ok).toBe(false);
    expect(f.groups.list()).toEqual([]);
    for (let index = 0; index < MAX_GROUP_MONITORS; index++)
      expect(f.groups.monitor(`group${index}`, ["first"]).ok).toBe(true);
    expect(f.groups.monitor("overflow", ["first"]).ok).toBe(false);
  });
});
