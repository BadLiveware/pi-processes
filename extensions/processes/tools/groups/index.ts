import type { ProcessManager } from "../../../../src/manager";
import type { ProcessGroupMonitorInfo } from "../../../../src/manager/group-monitors";
import type { ProcessesParamsType } from "../schema";
import type { GroupDetails } from "./schema";

export function groupLine(group: ProcessGroupMonitorInfo): string {
  const { summary } = group;
  let state = `monitoring ${group.mode}`;
  if (group.failFast) state += "/fail-fast";
  if (group.triggeredAt !== null) state = group.outcome ?? "triggered";
  return `${group.id} "${group.name}": ${state} (${summary.succeeded}/${summary.total} ok, ${summary.failed} failed, ${summary.killed} killed, ${summary.running} running)`;
}

export function executeGroup(
  params: ProcessesParamsType,
  manager: ProcessManager,
): GroupDetails {
  if (params.action === "listGroups") {
    const groups = manager.listGroups().reverse();
    return {
      action: "listGroups",
      success: true,
      groups,
      message: groups.map(groupLine).join("\n") || "No process group monitors",
    };
  }
  if (params.action === "clearGroup") {
    const key = params.groupId?.trim() || params.name?.trim();
    if (!key)
      return {
        action: "clearGroup",
        success: false,
        message: "groupId or name is required for clearGroup",
      };
    const result = manager.clearGroup(key);
    if (!result.ok)
      return { action: "clearGroup", success: false, message: result.message };
    return {
      action: "clearGroup",
      success: true,
      group: result.group,
      message: `Cleared process group monitor "${result.group.name}" (${result.group.id}).`,
    };
  }
  const result = manager.monitorGroup(
    params.name ?? "",
    params.processIds ?? [],
    {
      mode: params.groupMode,
      failFast: params.failFast,
      triggerTurn: params.triggerTurn,
    },
  );
  if (!result.ok)
    return { action: "monitorGroup", success: false, message: result.message };
  return {
    action: "monitorGroup",
    success: true,
    group: result.group,
    message: `${groupLine(result.group)}\nContinue other work, or end the turn if nothing else is useful; group notifications bring you back.`,
  };
}
