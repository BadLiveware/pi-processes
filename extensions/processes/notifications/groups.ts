import type { ProcessGroupMonitorInfo } from "../../../src/manager/group-monitors";
import type { ProcessNotificationDetails } from "./types";

export function groupNotification(
  group: ProcessGroupMonitorInfo,
): ProcessNotificationDetails {
  const { summary } = group;
  let attention: ProcessNotificationDetails["attention"] = "context";
  if (group.triggerTurn) attention = "turn";
  return {
    kind: "group_monitor",
    processId: group.id,
    processName: group.name,
    command: "",
    timestamp: group.triggeredAt ?? Date.now(),
    attention,
    group,
    summary: `Process group "${group.name}" ${group.outcome ?? "condition met"} (${summary.succeeded}/${summary.total} ok, ${summary.failed} failed, ${summary.killed} killed, ${summary.running} running).`,
  };
}
