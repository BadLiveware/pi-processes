import type { ProcessManager } from "../../../../src/manager";
import type {
  LogMatcherConfig,
  NotificationRegistry,
  WatchRemoveSpec,
  WatchUpdateResult,
} from "../../notifications/registry";
import { finishUpdate, prepareUpdate } from "../legacy/update";
import { normalizeLogMatchItems } from "../notify";
import type { ProcessesParamsType, UpdateDetails } from "../schema";
import { formatMatcherForModel } from "../watch-format";

export function executeUpdate(
  params: ProcessesParamsType,
  manager: ProcessManager,
  notifications: NotificationRegistry,
): UpdateDetails {
  if (!params.id) {
    return {
      action: "update",
      ok: false,
      error: "process update requires id",
      renamed: false,
      previousName: null,
      watches: { mode: null, before: [], applied: [], count: 0, items: [] },
    };
  }

  const before = manager.get(params.id);
  if (!before) {
    return {
      action: "update",
      ok: false,
      error: `process not found: ${params.id}`,
      renamed: false,
      previousName: null,
      watches: { mode: null, before: [], applied: [], count: 0, items: [] },
    };
  }

  if (params.name !== undefined && !params.name.trim()) {
    return {
      action: "update",
      ok: false,
      error: "process update name must be non-empty",
      process: before,
      renamed: false,
      previousName: null,
      watches: { mode: null, before: [], applied: [], count: 0, items: [] },
    };
  }

  const original = params;
  const prepared = prepareUpdate(params, manager, notifications);
  params = prepared.params;

  let process = before;
  let renamed = false;
  let previousName: string | null = null;

  if (params.name !== undefined) {
    const name = params.name.trim();
    const renamedProcess = manager.rename(before.id, name);
    if (!renamedProcess) {
      return {
        action: "update",
        ok: false,
        error: `process not found: ${params.id}`,
        renamed: false,
        previousName: null,
        watches: { mode: null, before: [], applied: [], count: 0, items: [] },
      };
    }

    renamed = before.name !== renamedProcess.name;
    if (renamed) {
      previousName = before.name;
    }
    process = renamedProcess;
  }

  let watchError: string | undefined;
  const watchesBefore =
    notifications.getWatchState(before.id)?.logMatches ?? [];
  let watchesApplied: LogMatcherConfig[] = [];
  const watchResult = applyWatchUpdate(
    before.id,
    params.watches,
    notifications,
  );

  if (params.watches && !watchResult) {
    watchError = `process update could not update watches for ${params.id}`;
  }

  if (watchResult) {
    watchesApplied =
      params.watches?.mode === "append" || params.watches?.mode === "replace"
        ? watchResult.logMatches.slice(
            params.watches.mode === "append" ? watchesBefore.length : 0,
          )
        : [];
  }

  const currentWatches =
    watchResult?.logMatches ??
    notifications.getWatchState(before.id)?.logMatches ??
    [];

  if (watchError) {
    return {
      action: "update",
      ok: false,
      error: watchError,
      process,
      renamed,
      previousName,
      watches: {
        mode: params.watches?.mode ?? null,
        before: watchesBefore,
        applied: [],
        count: currentWatches.length,
        items: currentWatches,
      },
    };
  }

  return finishUpdate(
    original,
    prepared,
    {
      action: "update",
      ok: true,
      process,
      renamed,
      previousName,
      watches: {
        mode: params.watches?.mode ?? null,
        before: watchesBefore,
        applied: watchesApplied,
        count: currentWatches.length,
        items: currentWatches,
      },
    },
    notifications,
  );
}

function applyWatchUpdate(
  processId: string,
  watches: ProcessesParamsType["watches"],
  notifications: NotificationRegistry,
): WatchUpdateResult | null {
  if (!watches) return null;

  const { mode } = watches;

  if (mode === "clear") {
    return notifications.clearWatches(processId);
  }

  const items = watches.items;
  if (items?.length === 0 && mode === "replace")
    return notifications.replaceWatches(processId, []);
  if (!items || items.length === 0) {
    throw new Error(
      `process update watches.items is required for mode=${mode}`,
    );
  }

  if (mode === "append" || mode === "replace") {
    const normalized = normalizeLogMatchItems(items as never, {
      actionLabel: "process update",
      pathPrefix: "watches.items",
    });

    return mode === "append"
      ? notifications.appendWatches(processId, normalized)
      : notifications.replaceWatches(processId, normalized);
  }

  if (mode === "remove") {
    const specs = normalizeWatchRemoveSpecs(items);
    return notifications.removeWatches(processId, specs);
  }

  throw new Error(`unsupported watch update mode: ${String(mode)}`);
}

// Watch items arrive already validated against the WatchUpdateItemParams
// schema (Pi validates tool call arguments before execute). Only semantic
// checks the schema cannot express remain here.
type WatchUpdateItem = NonNullable<
  NonNullable<ProcessesParamsType["watches"]>["items"]
>[number];

function normalizeWatchRemoveSpecs(
  items: WatchUpdateItem[],
): WatchRemoveSpec[] {
  return items.map((item, index) => {
    if (item.index !== undefined) {
      return { index: item.index };
    }

    if (item.pattern !== undefined) {
      if (item.pattern.trim().length === 0) {
        throw new Error(
          `process update watches.items[${index}].pattern must not be empty`,
        );
      }

      if (item.mode === "regex") {
        try {
          new RegExp(item.pattern);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `process update watches.items[${index}].pattern is not a valid regular expression: ${message}`,
          );
        }
      }

      return {
        pattern: item.pattern,
        mode: item.mode,
        stream: item.stream,
        repeat: item.repeat,
        on: item.on,
      };
    }

    throw new Error(
      `process update watches.items[${index}] requires either index or pattern for remove mode`,
    );
  });
}

export function formatUpdateDetails(details: UpdateDetails): string {
  if (!details.ok) {
    return details.error ?? "process update failed";
  }

  const parts: string[] = [];
  if (details.replayMatches?.length)
    parts.push(`${details.replayMatches.length} replay match(es).`);
  if (details.notify)
    parts.push(
      `Notify: success=${details.notify.onSuccess}, failure=${details.notify.onFailure}, killed=${details.notify.onKilled}.`,
    );

  if (details.renamed && details.previousName && details.process) {
    parts.push(
      `Renamed process from "${details.previousName}" to "${details.process.name}" (${details.process.id}).`,
    );
  } else if (details.process) {
    parts.push(
      `Updated process ${details.process.name} (${details.process.id}).`,
    );
  }

  const { mode, applied, before, count } = details.watches;

  if (mode === "append") {
    parts.push(
      `Appended ${applied.length} watch${applied.length === 1 ? "" : "es"}; ${count} active.`,
    );
  } else if (mode === "replace") {
    parts.push(
      `Replaced ${before.length} with ${applied.length} watch${applied.length === 1 ? "" : "es"}; ${count} active.`,
    );
  } else if (mode === "remove") {
    const removed = before.length - count;
    parts.push(
      `Removed ${removed} watch${removed === 1 ? "" : "es"}; ${count} active.`,
    );
  } else if (mode === "clear") {
    parts.push(
      `Cleared ${before.length} watch${before.length === 1 ? "" : "es"}; ${count} active.`,
    );
  }

  if (details.legacyWatches?.length) {
    parts.push(
      `Watches:\n${details.legacyWatches.map((watch, position) => `[${watch.index}] ${formatMatcherForModel(details.watches.items[position])} fired=${watch.fired}`).join("\n")}`,
    );
  }
  if (details.replayMatches?.length) {
    parts.push(
      `Replay:\n${details.replayMatches.map((match) => `[${match.watchIndex}] ${match.source}: ${match.line}`).join("\n")}`,
    );
  }
  return parts.join(" ") || "Updated process.";
}
