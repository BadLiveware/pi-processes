import { LIVE_STATUSES, type ManagerEvent, type ProcessInfo } from "../types";

export const MAX_GROUP_PROCESS_IDS = 50;
export const MAX_GROUP_MONITORS = 50;
export type ProcessGroupMode = "all" | "any";
export type ProcessGroupOutcome =
  | "all_succeeded"
  | "all_exited"
  | "any_succeeded"
  | "any_failed";

export interface ProcessGroupSummary {
  total: number;
  running: number;
  succeeded: number;
  failed: number;
  killed: number;
}

export interface ProcessGroupMonitorInfo {
  id: string;
  name: string;
  processIds: string[];
  mode: ProcessGroupMode;
  failFast: boolean;
  triggerTurn: boolean;
  createdAt: number;
  triggeredAt: number | null;
  outcome: ProcessGroupOutcome | null;
  triggerProcessId: string | null;
  summary: ProcessGroupSummary;
}

export interface GroupOptions {
  mode?: ProcessGroupMode;
  failFast?: boolean;
  triggerTurn?: boolean;
}

export type ProcessGroupMonitorResult =
  | { ok: true; group: ProcessGroupMonitorInfo }
  | { ok: false; reason: "invalid"; message: string };
export type ProcessGroupClearResult =
  | { ok: true; group: ProcessGroupMonitorInfo }
  | { ok: false; reason: "not_found"; message: string };

export class GroupMonitors {
  private groups = new Map<string, ProcessGroupMonitorInfo>();
  private counter = 0;

  constructor(
    private get: (id: string) => ProcessInfo | null,
    private emit: (event: ManagerEvent) => void,
  ) {}

  monitor(
    name: string,
    processIds: string[],
    options?: GroupOptions,
  ): ProcessGroupMonitorResult {
    const invalid = (message: string): ProcessGroupMonitorResult => ({
      ok: false,
      reason: "invalid",
      message,
    });
    const trimmedName = name.trim();
    if (!trimmedName) return invalid("name is required for monitorGroup");
    if (!Array.isArray(processIds) || processIds.length === 0)
      return invalid("processIds must contain at least one process id");
    const ids = [...new Set(processIds.map((id) => id.trim()))];
    if (ids.some((id) => !id))
      return invalid("processIds must be non-empty strings");
    if (ids.length > MAX_GROUP_PROCESS_IDS)
      return invalid(
        `processIds must contain <= ${MAX_GROUP_PROCESS_IDS} unique process ids`,
      );
    if (this.groups.size >= MAX_GROUP_MONITORS)
      return invalid(
        `At most ${MAX_GROUP_MONITORS} process group monitors can be active`,
      );
    const missing = ids.filter((id) => !this.get(id));
    if (missing.length > 0)
      return invalid(`Unknown process id(s): ${missing.join(", ")}`);
    const mode = options?.mode ?? "all";
    if (mode !== "all" && mode !== "any")
      return invalid(`Unsupported group mode: ${String(mode)}`);
    let failFast = false;
    if (mode === "all") failFast = options?.failFast ?? true;
    const group: ProcessGroupMonitorInfo = {
      id: `group_${++this.counter}`,
      name: trimmedName,
      processIds: ids,
      mode,
      failFast,
      triggerTurn: options?.triggerTurn ?? true,
      createdAt: Date.now(),
      triggeredAt: null,
      outcome: null,
      triggerProcessId: null,
      summary: this.summary(ids),
    };
    this.groups.set(group.id, group);
    this.evaluate(group);
    this.emit({ type: "processes_changed" });
    return { ok: true, group: this.snapshot(group) };
  }

  list(): ProcessGroupMonitorInfo[] {
    return [...this.groups.values()].map((group) => this.snapshot(group));
  }

  hasTurnGroupForProcess(id: string): boolean {
    return [...this.groups.values()].some(
      (group) => group.triggerTurn && group.processIds.includes(id),
    );
  }

  clear(idOrName: string): ProcessGroupClearResult {
    const key = idOrName.trim();
    const group =
      this.groups.get(key) ??
      [...this.groups.values()].find((item) => item.name === key);
    if (!group)
      return {
        ok: false,
        reason: "not_found",
        message: `Process group monitor not found: ${idOrName}`,
      };
    this.groups.delete(group.id);
    this.emit({ type: "processes_changed" });
    return { ok: true, group: this.snapshot(group) };
  }

  update(id: string): void {
    for (const group of this.groups.values()) {
      if (group.processIds.includes(id)) this.evaluate(group);
    }
  }

  retains(id: string): boolean {
    return [...this.groups.values()].some(
      (group) =>
        group.processIds.includes(id) &&
        (group.triggeredAt === null ||
          group.processIds.some((member) => {
            const info = this.get(member);
            return info !== null && LIVE_STATUSES.has(info.status);
          })),
    );
  }

  removeReferences(id: string): void {
    for (const [key, group] of this.groups) {
      if (group.processIds.includes(id)) this.groups.delete(key);
    }
  }

  dispose(): void {
    this.groups.clear();
  }

  private evaluate(group: ProcessGroupMonitorInfo): void {
    if (group.triggeredAt !== null) return;
    const processes = group.processIds.map((id) => this.get(id));
    let trigger: ProcessInfo | undefined;
    let outcome: ProcessGroupOutcome | null = null;
    if (group.mode === "any") {
      trigger = processes.find(
        (info): info is ProcessInfo =>
          info !== null && !LIVE_STATUSES.has(info.status),
      );
      if (trigger) {
        outcome = "any_succeeded";
        if (this.failed(trigger)) outcome = "any_failed";
      }
    } else {
      if (group.failFast)
        trigger = processes.find(
          (info): info is ProcessInfo => info !== null && this.failed(info),
        );
      if (trigger) outcome = "any_failed";
      else if (
        processes.every(
          (info) => info !== null && !LIVE_STATUSES.has(info.status),
        )
      ) {
        outcome = "all_exited";
        if (
          processes.every(
            (info) => info?.status === "exited" && info.success === true,
          )
        )
          outcome = "all_succeeded";
      }
    }
    if (outcome === null) return;
    group.outcome = outcome;
    group.triggerProcessId = trigger?.id ?? null;
    group.triggeredAt = Date.now();
    this.emit({
      type: "process_group_monitor_triggered",
      group: this.snapshot(group),
    });
  }

  private failed(info: ProcessInfo): boolean {
    return (
      info.status === "killed" ||
      (info.status === "exited" && info.success === false)
    );
  }

  private summary(ids: string[]): ProcessGroupSummary {
    const summary: ProcessGroupSummary = {
      total: ids.length,
      running: 0,
      succeeded: 0,
      failed: 0,
      killed: 0,
    };
    for (const id of ids) {
      const info = this.get(id);
      if (!info) summary.failed++;
      else if (LIVE_STATUSES.has(info.status)) summary.running++;
      else if (info.status === "killed") summary.killed++;
      else if (info.success) summary.succeeded++;
      else summary.failed++;
    }
    return summary;
  }

  private snapshot(group: ProcessGroupMonitorInfo): ProcessGroupMonitorInfo {
    return {
      ...group,
      processIds: [...group.processIds],
      summary: this.summary(group.processIds),
    };
  }
}
