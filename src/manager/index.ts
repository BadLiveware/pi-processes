import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import type {
  AdoptProcessOptions,
  KillResult,
  ManagerEvent,
  ProcessInfo,
  WriteResult,
} from "../types";
import {
  GroupMonitors,
  type GroupOptions,
  type ProcessGroupClearResult,
  type ProcessGroupMonitorInfo,
  type ProcessGroupMonitorResult,
} from "./group-monitors";
import { formatProcess } from "./internal-types";
import { ProcessLogStore } from "./process-log-store";
import { ProcessOutput } from "./process-output";
import { ProcessRegistry } from "./process-registry";
import { ProcessRuntimeController } from "./process-runtime-controller";

interface ProcessManagerOptions {
  getConfiguredShellPath?: () => string | undefined;
}

export class ProcessManager {
  private events = new EventEmitter();

  private registry: ProcessRegistry;
  private logStore: ProcessLogStore;
  private output: ProcessOutput;
  private runtime: ProcessRuntimeController;
  private groups: GroupMonitors;

  constructor(options?: ProcessManagerOptions) {
    const emit = (event: ManagerEvent): void => {
      this.events.emit("event", event);
      if (event.type === "process_ended") this.groups.update(event.info.id);
    };

    this.registry = new ProcessRegistry();
    this.groups = new GroupMonitors((id) => this.get(id), emit);
    this.logStore = new ProcessLogStore();

    this.output = new ProcessOutput({
      emit,
      logStore: this.logStore,
    });

    this.runtime = new ProcessRuntimeController({
      registry: this.registry,
      logs: this.logStore,
      output: this.output,
      emit,
      getConfiguredShellPath:
        options?.getConfiguredShellPath ?? (() => undefined),
      retainFinished: (id) => this.groups.retains(id),
      onRemoved: (id) => this.groups.removeReferences(id),
    });
  }

  onEvent(listener: (event: ManagerEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  start(
    name: string,
    command: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): ProcessInfo {
    const managed = this.runtime.start(name, command, cwd, env);
    return formatProcess(managed);
  }

  /**
   * Adopt an externally spawned child process. The child must run in a
   * detached process group with piped stdio (see
   * ProcessRuntimeController.adopt for the full contract).
   */
  adopt(
    name: string,
    command: string,
    cwd: string,
    child: ChildProcess,
    opts?: AdoptProcessOptions,
  ): ProcessInfo {
    const managed = this.runtime.adopt(name, command, cwd, child, opts);
    return formatProcess(managed);
  }

  list(): ProcessInfo[] {
    return this.registry.list();
  }

  get(id: string): ProcessInfo | null {
    return this.registry.getPublicInfo(id);
  }

  rename(id: string, name: string): ProcessInfo | null {
    const info = this.registry.rename(id, name);
    if (info) {
      this.events.emit("event", {
        type: "processes_changed",
      } satisfies ManagerEvent);
    }
    return info;
  }

  getOutput(
    id: string,
    tailLines = 100,
  ): { stdout: string[]; stderr: string[]; status: string } | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;

    return {
      stdout: this.logStore.readTailLines(managed.stdoutFile, tailLines),
      stderr: this.logStore.readTailLines(managed.stderrFile, tailLines),
      status: managed.status,
    };
  }

  getCombinedOutput(
    id: string,
    tailLines = 100,
  ): Array<{ type: "stdout" | "stderr"; text: string }> | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;
    return this.logStore.getCombinedOutput(managed.combinedFile, tailLines);
  }

  /**
   * Return output capped at 16 MiB per stream. Use getLogFiles() and stream
   * the returned paths when an exact, unbounded read is required.
   */
  getFullOutput(id: string): { stdout: string; stderr: string } | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;
    return {
      stdout: this.logStore.readFullFile(managed.stdoutFile),
      stderr: this.logStore.readFullFile(managed.stderrFile),
    };
  }

  getLogFiles(
    id: string,
  ): { stdoutFile: string; stderrFile: string; combinedFile: string } | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;
    return {
      stdoutFile: managed.stdoutFile,
      stderrFile: managed.stderrFile,
      combinedFile: managed.combinedFile,
    };
  }

  getFileSize(id: string): { stdout: number; stderr: number } | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;
    return this.logStore.getFileSize({
      stdoutFile: managed.stdoutFile,
      stderrFile: managed.stderrFile,
      combinedFile: managed.combinedFile,
    });
  }

  async kill(
    id: string,
    opts?: { signal?: NodeJS.Signals; timeoutMs?: number },
  ): Promise<KillResult> {
    return this.runtime.kill(id, opts);
  }

  writeToStdin(
    id: string,
    data: string,
    opts?: { end?: boolean },
  ): WriteResult {
    return this.runtime.writeToStdin(id, data, opts);
  }

  killAll(): void {
    this.runtime.killAll();
  }

  clearFinished(): number {
    return this.runtime.clearFinished();
  }

  monitorGroup(
    name: string,
    processIds: string[],
    options?: GroupOptions,
  ): ProcessGroupMonitorResult {
    return this.groups.monitor(name, processIds, options);
  }

  listGroups(): ProcessGroupMonitorInfo[] {
    return this.groups.list();
  }

  clearGroup(idOrName: string): ProcessGroupClearResult {
    const result = this.groups.clear(idOrName);
    if (result.ok) this.runtime.refreshFinishedRetention();
    return result;
  }

  hasTurnGroupForProcess(id: string): boolean {
    return this.groups.hasTurnGroupForProcess(id);
  }

  stopWatcher(): void {
    this.runtime.stopWatcher();
  }

  cleanup(): void {
    this.runtime.beginShutdown();
    this.runtime.stopWatcher();
    this.output.clearAll();
    this.runtime.killAllLive();
    this.logStore.cleanup();
    this.groups.dispose();
  }

  [Symbol.dispose](): void {
    this.cleanup();
  }
}

export type {
  KillResult,
  ManagerEvent,
  ProcessInfo,
  ProcessStatus,
  WriteResult,
} from "../types";
export type {
  GroupOptions,
  ProcessGroupClearResult,
  ProcessGroupMode,
  ProcessGroupMonitorInfo,
  ProcessGroupMonitorResult,
  ProcessGroupOutcome,
  ProcessGroupSummary,
} from "./group-monitors";
