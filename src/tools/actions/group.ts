import { ToolBody, ToolCallHeader } from "@aliou/pi-utils-ui";
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type {
  ExecuteResult,
  ProcessesDetails,
  ProcessGroupMode,
  ProcessGroupMonitorInfo,
} from "../../constants";
import type { ProcessManager } from "../../manager";

interface GroupParams {
  action?: string;
  name?: string;
  processIds?: string[];
  groupMode?: ProcessGroupMode | string;
  failFast?: boolean;
  triggerTurn?: boolean;
  groupId?: string;
}

function summaryText(group: ProcessGroupMonitorInfo): string {
  const { summary } = group;
  const failed = summary.failed + summary.killed;
  return `${summary.succeeded}/${summary.total} ok, ${failed} failed, ${summary.running} running`;
}

function groupLine(group: ProcessGroupMonitorInfo): string {
  const state = group.triggeredAt
    ? `${group.outcome ?? "triggered"}`
    : `monitoring ${group.mode}${group.failFast ? "/fail-fast" : ""}`;
  return `${group.id} "${group.name}": ${state} (${summaryText(group)})`;
}

export function executeMonitorGroup(
  params: GroupParams,
  manager: ProcessManager,
): ExecuteResult {
  const name = params.name?.trim();
  if (!name) {
    return {
      content: [{ type: "text", text: "name is required for monitorGroup" }],
      details: {
        action: "monitorGroup",
        success: false,
        message: "name is required for monitorGroup",
      },
    };
  }

  const mode = params.groupMode ?? "all";
  if (mode !== "all" && mode !== "any") {
    const message = `Unsupported groupMode: ${String(mode)}`;
    return {
      content: [{ type: "text", text: message }],
      details: { action: "monitorGroup", success: false, message },
    };
  }

  const result = manager.monitorGroup(name, params.processIds ?? [], {
    mode,
    failFast: params.failFast,
    triggerTurn: params.triggerTurn,
  });

  if (!result.ok) {
    return {
      content: [{ type: "text", text: result.message }],
      details: {
        action: "monitorGroup",
        success: false,
        message: result.message,
      },
    };
  }

  const group = result.group;
  const status = group.triggeredAt
    ? `Group condition already met: ${group.outcome ?? "triggered"}`
    : `Monitoring ${group.processIds.length} process(es) as "${group.name}" (${group.mode}${group.failFast ? ", fail-fast" : ""})`;
  const message = `${status}.
${groupLine(group)}
Continue other work, or stop the turn if nothing else is useful; group notifications will trigger follow-up.`;

  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "monitorGroup",
      success: true,
      message,
      group,
    },
  };
}

export function executeListGroups(manager: ProcessManager): ExecuteResult {
  const groups = manager.listGroups();
  if (groups.length === 0) {
    return {
      content: [{ type: "text", text: "No process group monitors" }],
      details: {
        action: "listGroups",
        success: true,
        message: "No process group monitors",
        groups: [],
      },
    };
  }

  const message = `${groups.length} process group monitor(s):\n${groups
    .map(groupLine)
    .join("\n")}`;
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "listGroups",
      success: true,
      message,
      groups,
    },
  };
}

export function executeClearGroup(
  params: GroupParams,
  manager: ProcessManager,
): ExecuteResult {
  const groupId = params.groupId?.trim() ?? params.name?.trim();
  if (!groupId) {
    return {
      content: [
        { type: "text", text: "groupId or name is required for clearGroup" },
      ],
      details: {
        action: "clearGroup",
        success: false,
        message: "groupId or name is required for clearGroup",
      },
    };
  }

  const result = manager.clearGroup(groupId);
  if (!result.ok) {
    return {
      content: [{ type: "text", text: result.message }],
      details: {
        action: "clearGroup",
        success: false,
        message: result.message,
      },
    };
  }

  const message = `Cleared process group monitor "${result.group.name}" (${result.group.id}).`;
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "clearGroup",
      success: true,
      message,
      group: result.group,
    },
  };
}

export function renderGroupCall(
  args: GroupParams,
  theme: Theme,
): ToolCallHeader {
  return new ToolCallHeader(
    {
      toolName: "Process",
      action: args.action ?? "group",
      mainArg: args.name ?? args.groupId,
    },
    theme,
  );
}

export function renderGroupResult(
  result: AgentToolResult<ProcessesDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): ToolBody {
  const { details } = result;
  const value = details.group
    ? groupLine(details.group)
    : details.groups && details.groups.length > 0
      ? details.groups.map(groupLine).join("\n")
      : details.message;

  return new ToolBody(
    {
      fields: [
        {
          label: "Process groups",
          value,
          showCollapsed: true,
        },
      ],
    },
    options,
    theme,
  );
}
