import { MAX_LOG_MATCHERS_PER_PROCESS } from "../../notifications/log-matchers";
import type {
  LogMatcherConfig,
  NotifyConfig,
} from "../../notifications/registry";
import { normalizeLogMatchItems, normalizeNotifyConfig } from "../notify";
import type { ProcessesParamsType } from "../schema";

export function normalizeLegacyWatches(
  watches: NonNullable<ProcessesParamsType["logWatches"]>,
): LogMatcherConfig[] {
  return normalizeLogMatchItems(
    watches.map((watch) => ({
      ...watch,
      pattern: watch.pattern.trim(),
      mode: "regex",
      on: "turn",
    })),
    {
      actionLabel: "process",
      pathPrefix: "logWatches",
    },
  );
}

export function legacyAttention(enabled: boolean): "turn" | "context" {
  if (enabled) return "turn";
  return "context";
}

export function startNotify(params: ProcessesParamsType): NotifyConfig {
  const notify = normalizeNotifyConfig(params.notify);
  if (params.notify === undefined) {
    notify.onSuccess = "context";
    notify.onFailure = "turn";
    notify.onKilled = "context";
  }
  applyLegacyAlerts(notify, params);
  if (params.logWatches !== undefined) {
    notify.logMatches = [
      ...(notify.logMatches ?? []),
      ...normalizeLegacyWatches(params.logWatches),
    ];
  }
  if ((notify.logMatches?.length ?? 0) > MAX_LOG_MATCHERS_PER_PROCESS)
    throw new Error(
      `process start supports at most ${MAX_LOG_MATCHERS_PER_PROCESS} log watches`,
    );
  return notify;
}

export function applyLegacyAlerts(
  notify: NotifyConfig,
  params: ProcessesParamsType,
): void {
  if (params.alertOnSuccess !== undefined)
    notify.onSuccess = legacyAttention(params.alertOnSuccess);
  if (params.alertOnFailure !== undefined)
    notify.onFailure = legacyAttention(params.alertOnFailure);
  if (params.alertOnKill !== undefined)
    notify.onKilled = legacyAttention(params.alertOnKill);
}
