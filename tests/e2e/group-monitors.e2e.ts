import { expect } from "vitest";
import { ProcessManager } from "../../src/manager";
import { test } from "./fixtures";
import { collectEvents, waitForEnd } from "./utils";

const CONTROLLED_EXIT = `bash -c 'read code; exit "$code"'`;

test("aggregates real successful exits and clears a settled monitor with its members", async ({
  cwd,
}) => {
  using manager = new ProcessManager();
  const events = collectEvents(manager);
  const first = manager.start("first", CONTROLLED_EXIT, cwd);
  const second = manager.start("second", CONTROLLED_EXIT, cwd);
  manager.monitorGroup("builds", [first.id, second.id]);
  manager.writeToStdin(first.id, "0\n");
  await waitForEnd(manager, first.id);
  expect(
    events.filter((event) => event.type === "process_group_monitor_triggered"),
  ).toHaveLength(0);
  expect(manager.clearFinished()).toBe(0);
  expect(manager.get(first.id)?.success).toBe(true);
  manager.writeToStdin(second.id, "0\n");
  await waitForEnd(manager, second.id);
  expect(
    events.filter((event) => event.type === "process_group_monitor_triggered"),
  ).toHaveLength(1);
  expect(manager.listGroups()[0].outcome).toBe("all_succeeded");
  expect(manager.clearFinished()).toBe(2);
  expect(manager.listGroups()).toEqual([]);
});

test("fails fast once and preserves settled member summaries while another member runs", async ({
  cwd,
}) => {
  using manager = new ProcessManager();
  const events = collectEvents(manager);
  const first = manager.start("first", CONTROLLED_EXIT, cwd);
  const second = manager.start("second", CONTROLLED_EXIT, cwd);
  manager.monitorGroup("builds", [first.id, second.id]);
  manager.writeToStdin(first.id, "7\n");
  await waitForEnd(manager, first.id);
  expect(manager.listGroups()[0]).toMatchObject({
    outcome: "any_failed",
    summary: { failed: 1, running: 1 },
  });
  expect(manager.clearFinished()).toBe(0);
  expect(manager.hasTurnGroupForProcess(second.id)).toBe(true);
  manager.writeToStdin(second.id, "0\n");
  await waitForEnd(manager, second.id);
  expect(
    events.filter((event) => event.type === "process_group_monitor_triggered"),
  ).toHaveLength(1);
  expect(manager.listGroups()[0].summary).toMatchObject({
    failed: 1,
    succeeded: 1,
    running: 0,
  });
});

test("waits for all outcomes without fail-fast, then evaluates already-settled members", async ({
  cwd,
}) => {
  using manager = new ProcessManager();
  const first = manager.start("first", CONTROLLED_EXIT, cwd);
  const second = manager.start("second", CONTROLLED_EXIT, cwd);
  manager.monitorGroup("all", [first.id, second.id], { failFast: false });
  manager.writeToStdin(first.id, "1\n");
  await waitForEnd(manager, first.id);
  expect(manager.listGroups()[0].triggeredAt).toBeNull();
  expect(manager.clearFinished()).toBe(0);
  manager.writeToStdin(second.id, "0\n");
  await waitForEnd(manager, second.id);
  expect(manager.listGroups()[0].outcome).toBe("all_exited");
  const settled = manager.monitorGroup("settled", [first.id, second.id], {
    failFast: false,
  });
  expect(settled).toMatchObject({ ok: true, group: { outcome: "all_exited" } });
});

test("clearing an active monitor restores member ownership and releases retained records", async ({
  cwd,
}) => {
  using manager = new ProcessManager();
  const first = manager.start("first", CONTROLLED_EXIT, cwd);
  const second = manager.start("second", CONTROLLED_EXIT, cwd);
  manager.monitorGroup("jobs", [first.id, second.id], { failFast: false });
  manager.writeToStdin(first.id, "0\n");
  await waitForEnd(manager, first.id);
  expect(manager.clearGroup("jobs").ok).toBe(true);
  expect(manager.hasTurnGroupForProcess(second.id)).toBe(false);
  expect(manager.clearFinished()).toBe(1);
  manager.writeToStdin(second.id, "0\n");
  await waitForEnd(manager, second.id);
  expect(manager.listGroups()).toEqual([]);
});

test("any-mode reacts to real external termination and retains ownership of the other member", async ({
  cwd,
}) => {
  using manager = new ProcessManager();
  const first = manager.start("first", CONTROLLED_EXIT, cwd);
  const second = manager.start("second", CONTROLLED_EXIT, cwd);
  manager.monitorGroup("race", [first.id, second.id], { mode: "any" });
  process.kill(-first.pid, "SIGTERM");
  await waitForEnd(manager, first.id);
  expect(manager.listGroups()[0]).toMatchObject({
    outcome: "any_failed",
    summary: { killed: 1, running: 1 },
  });
  expect(manager.hasTurnGroupForProcess(second.id)).toBe(true);
});
