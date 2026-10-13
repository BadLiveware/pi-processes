import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProcessManager } from "../../../../src/manager";
import type { NotificationRegistry } from "../../notifications/registry";
import { startNotify } from "../legacy/notify";
import type { ProcessesParamsType, StartDetails } from "../schema";
import { formatMatcherForModel } from "../watch-format";
import { buildSessionEnv } from "./session-env";

export function executeStart(
  params: ProcessesParamsType,
  manager: ProcessManager,
  ctx: ExtensionContext,
  notifications: NotificationRegistry,
): StartDetails {
  if (!params.name) {
    throw new Error("process start requires name");
  }

  if (!params.command) {
    throw new Error("process start requires command");
  }

  const notify = startNotify(params);

  const cwd = params.cwd ?? ctx.cwd;
  const process = manager.start(
    params.name,
    params.command,
    cwd,
    buildSessionEnv(ctx),
  );
  notifications.register(process.id, notify);
  if (params.logWatches?.length) {
    const start = (notify.logMatches?.length ?? 0) - params.logWatches.length;
    notifications.markLegacyWatches(
      process.id,
      params.logWatches.map((_, index) => start + index),
    );
  }

  return {
    action: "start",
    process,
    notify,
  };
}

export function formatStartDetails(details: StartDetails): string {
  const process = details.process;
  const parts = [
    `Started process ${process.name} (${process.id}) with pid ${process.pid}.`,
    `Exit attention: success=${details.notify.onSuccess}, failure=${details.notify.onFailure}, killed=${details.notify.onKilled}.`,
  ];

  if (details.notify.logMatches && details.notify.logMatches.length > 0) {
    parts.push(
      `Watches:\n${details.notify.logMatches
        .map((matcher) => formatMatcherForModel(matcher))
        .join("\n")}`,
    );
    parts.push(
      "Continue other work; watch notifications will trigger follow-up.",
    );
  }

  return parts.join(" ");
}
