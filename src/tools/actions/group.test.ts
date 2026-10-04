import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessManager } from "../../manager";
import { executeAction } from ".";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("process group actions", () => {
  let manager: ProcessManager;

  afterEach(() => {
    manager.cleanup();
  });

  it("registers and lists non-blocking group monitors", async () => {
    manager = new ProcessManager();
    const first = manager.start("first", "bash -c 'sleep 0.2; exit 0'", "/tmp");
    const second = manager.start(
      "second",
      "bash -c 'sleep 0.2; exit 0'",
      "/tmp",
    );

    const result = await executeAction(
      {
        action: "monitorGroup",
        name: "suite",
        processIds: [first.id, second.id],
        groupMode: "all",
      },
      manager,
      { cwd: "/tmp" } as ExtensionContext,
    );

    expect(result.details.success).toBe(true);
    expect(result.details.group).toMatchObject({
      name: "suite",
      mode: "all",
      failFast: true,
      triggerTurn: true,
    });
    expect(result.content[0]?.text).toContain("stop the turn");
    expect(result.content[0]?.text).toContain("group notifications");

    const list = await executeAction({ action: "listGroups" }, manager, {
      cwd: "/tmp",
    } as ExtensionContext);

    expect(list.details.groups).toHaveLength(1);
    expect(list.content[0]?.text).toContain("suite");
  });

  it("clears group monitors by id", async () => {
    manager = new ProcessManager();
    const proc = manager.start("proc", "cat", "/tmp");
    const monitor = await executeAction(
      {
        action: "monitorGroup",
        name: "to-clear",
        processIds: [proc.id],
        groupMode: "any",
      },
      manager,
      { cwd: "/tmp" } as ExtensionContext,
    );

    const groupId = monitor.details.group?.id;
    expect(groupId).toBeTruthy();

    const cleared = await executeAction(
      { action: "clearGroup", groupId },
      manager,
      { cwd: "/tmp" } as ExtensionContext,
    );

    expect(cleared.details.success).toBe(true);
    const list = manager.listGroups();
    expect(list).toHaveLength(0);
  });

  it("reports already-satisfied groups without requiring polling", async () => {
    manager = new ProcessManager();
    const proc = manager.start("done", "true", "/tmp");
    await sleep(100);

    const result = await executeAction(
      {
        action: "monitorGroup",
        name: "already-done",
        processIds: [proc.id],
        groupMode: "all",
      },
      manager,
      { cwd: "/tmp" } as ExtensionContext,
    );

    expect(result.details.success).toBe(true);
    expect(result.details.group?.outcome).toBe("all_succeeded");
    expect(result.content[0]?.text).toContain("already met");
  });
});
