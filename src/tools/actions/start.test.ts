import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessManager } from "../../manager";
import { executeStart } from "./start";

describe("executeStart", () => {
  let manager: ProcessManager;

  afterEach(() => {
    manager.cleanup();
  });

  it("does not suggest adding alerts when alertOnSuccess is configured", () => {
    manager = new ProcessManager();

    const result = executeStart(
      {
        name: "with-success-alert",
        command: "cat",
        alertOnSuccess: true,
      },
      manager,
      { cwd: "/tmp" } as ExtensionContext,
    );

    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain('Started "with-success-alert"');
    expect(result.content[0]?.text).not.toContain(
      "make sure alertOnSuccess, alertOnFailure, alertOnKill, or logWatches are set instead of sleeping or polling.",
    );
  });

  it("does not suggest adding alerts when alertOnFailure is configured", () => {
    manager = new ProcessManager();

    const result = executeStart(
      {
        name: "with-failure-alert",
        command: "cat",
        alertOnFailure: true,
      },
      manager,
      { cwd: "/tmp" } as ExtensionContext,
    );

    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain('Started "with-failure-alert"');
    expect(result.content[0]?.text).not.toContain(
      "make sure alertOnSuccess, alertOnFailure, alertOnKill, or logWatches are set instead of sleeping or polling.",
    );
  });

  it("advises configuring monitoring when none is set", () => {
    manager = new ProcessManager();

    const result = executeStart(
      {
        name: "without-monitoring",
        command: "cat",
      },
      manager,
      { cwd: "/tmp" } as ExtensionContext,
    );

    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain(
      "If completion or a marker should bring you back, make sure alertOnSuccess, alertOnFailure, alertOnKill, or logWatches are set instead of sleeping or polling.",
    );
  });
});
