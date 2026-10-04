import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  MESSAGE_TYPE_PROCESS_UPDATE,
  type ProcessGroupMonitorInfo,
} from "../constants";
import type { ProcessManager } from "../manager";
import { formatRuntime } from "../utils";

export interface ProcessGroupMonitorDetails {
  kind: "group_monitor";
  group: ProcessGroupMonitorInfo;
  runtime: string;
}

function outcomeText(group: ProcessGroupMonitorInfo): string {
  switch (group.outcome) {
    case "all_succeeded":
      return "all succeeded";
    case "all_exited":
      return "all exited";
    case "any_succeeded":
      return "one succeeded";
    case "any_failed":
      return "one failed";
    default:
      return "condition met";
  }
}

export function setupProcessGroupHook(
  pi: ExtensionAPI,
  manager: ProcessManager,
) {
  manager.onEvent((event) => {
    if (event.type !== "process_group_monitor_triggered") return;

    const group = event.group;
    const runtime = formatRuntime(group.createdAt, group.triggeredAt);
    const summary = `${group.summary.succeeded}/${group.summary.total} ok, ${group.summary.failed} failed, ${group.summary.killed} killed, ${group.summary.running} running`;
    const message = `Process group '${group.name}' ${outcomeText(group)} (${summary}, ${runtime})`;

    const details: ProcessGroupMonitorDetails = {
      kind: "group_monitor",
      group,
      runtime,
    };

    pi.sendMessage(
      {
        customType: MESSAGE_TYPE_PROCESS_UPDATE,
        content: message,
        display: true,
        details,
      },
      { triggerTurn: group.triggerTurn },
    );
  });
}
