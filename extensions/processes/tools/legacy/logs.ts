import type { ProcessManager } from "../../../../src/manager";
import type { ProcessesParamsType } from "../schema";
import type { LogsDetails } from "./schema";

export function executeLogs(
  params: ProcessesParamsType,
  manager: ProcessManager,
): LogsDetails {
  if (!params.id) throw new Error("process logs requires id");
  const process = manager.get(params.id);
  const logFiles = manager.getLogFiles(params.id);
  if (!process || !logFiles) throw new Error(`process not found: ${params.id}`);
  return { action: "logs", id: params.id, processName: process.name, logFiles };
}

export function formatLogs(details: LogsDetails): string {
  return `Logs for "${details.processName}" (${details.id}):\nstdout: ${details.logFiles.stdoutFile}\nstderr: ${details.logFiles.stderrFile}\ncombined: ${details.logFiles.combinedFile}`;
}
