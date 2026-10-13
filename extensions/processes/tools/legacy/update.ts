import type { ProcessManager } from "../../../../src/manager";
import { MAX_LOG_MATCHERS_PER_PROCESS } from "../../notifications/log-matchers";
import type { NotificationRegistry } from "../../notifications/registry";
import { normalizeLogMatchItems } from "../notify";
import type { ProcessesParamsType, UpdateDetails } from "../schema";
import {
  applyLegacyAlerts,
  normalizeLegacyWatches,
  startNotify,
} from "./notify";
import {
  DEFAULT_REPLAY_MATCHES,
  MAX_REPLAY_MATCHES,
  MAX_REPLAY_TAIL_LINES,
} from "./schema";

export interface PreparedUpdate {
  params: ProcessesParamsType;
  legacyMode?: "append" | "replace";
  replay?: {
    mode: "append" | "replace";
    tailLines: number;
    maxMatches: number;
  };
}

export function prepareUpdate(
  params: ProcessesParamsType,
  manager: ProcessManager,
  registry: NotificationRegistry,
): PreparedUpdate {
  const prepared: PreparedUpdate = { params: { ...params } };
  if (!params.id || !manager.get(params.id)) return prepared;
  const update =
    params.logWatchUpdate ??
    (params.watchAction
      ? {
          mode: params.watchAction,
          watches: params.logWatches,
          watchIndexes: params.watchIndexes,
          replayTailLines: params.replayTailLines,
          maxReplayMatches: params.maxReplayMatches,
        }
      : undefined);
  if (params.watches && update)
    throw new Error(
      "process update accepts watches or logWatchUpdate/watchAction, not both",
    );
  if (update) {
    if (update.mode === "list") prepared.params.watches = undefined;
    else if (update.mode === "clear")
      prepared.params.watches = { mode: "clear" };
    else if (update.mode === "remove") {
      const indexes = update.watchIndexes;
      if (
        !indexes ||
        indexes.some((index) => !Number.isInteger(index) || index < 0)
      )
        throw new Error(
          "process update remove requires non-negative watchIndexes",
        );
      const ids = registry.getWatchIds(params.id);
      const positions = ids
        .map((id, index) => ({ id, index }))
        .filter((entry) => indexes.includes(entry.id));
      prepared.params.watches = undefined;
      if (positions.length > 0)
        prepared.params.watches = {
          mode: "remove",
          items: positions.map(({ index }) => ({ index })),
        };
    } else {
      if (!update.watches?.length)
        throw new Error(`logWatches is required for ${update.mode}`);
      const watches = normalizeLegacyWatches(update.watches);
      prepared.params.watches = { mode: update.mode, items: watches };
      prepared.legacyMode = update.mode;
      const tailLines = update.replayTailLines ?? 0;
      const maxMatches = update.maxReplayMatches ?? DEFAULT_REPLAY_MATCHES;
      if (
        !Number.isInteger(tailLines) ||
        tailLines < 0 ||
        tailLines > MAX_REPLAY_TAIL_LINES
      )
        throw new Error(
          `replayTailLines must be an integer from 0 to ${MAX_REPLAY_TAIL_LINES}`,
        );
      if (
        !Number.isInteger(maxMatches) ||
        maxMatches < 0 ||
        maxMatches > MAX_REPLAY_MATCHES
      )
        throw new Error(
          `maxReplayMatches must be an integer from 0 to ${MAX_REPLAY_MATCHES}`,
        );
      prepared.replay = { mode: update.mode, tailLines, maxMatches };
    }
  }
  if (params.notify?.logMatches !== undefined) {
    if (prepared.params.watches)
      throw new Error(
        "process update accepts notify.logMatches or a watches update, not both",
      );
    prepared.params.watches = {
      mode: "replace",
      items: params.notify.logMatches,
    };
  }
  const watches = prepared.params.watches;
  if (watches?.mode === "append" || watches?.mode === "replace") {
    if (
      !watches.items ||
      (watches.mode === "append" && watches.items.length === 0)
    )
      throw new Error(
        `process update watches.items is required for mode=${watches.mode}`,
      );
    if (watches.items.length > MAX_LOG_MATCHERS_PER_PROCESS)
      throw new Error(
        `process update supports at most ${MAX_LOG_MATCHERS_PER_PROCESS} matchers`,
      );
    const items = watches.items.map((item) => {
      if (item.pattern === undefined)
        throw new Error("process update watches.items requires pattern");
      return { ...item, pattern: item.pattern };
    });
    prepared.params.watches = {
      ...watches,
      items: normalizeLogMatchItems(items, {
        actionLabel: "process update",
        pathPrefix: "watches.items",
      }),
    };
  }
  if (watches?.mode === "remove") {
    if (!watches.items?.length)
      throw new Error(
        "process update watches.items is required for mode=remove",
      );
    for (const item of watches.items) {
      if (item.index !== undefined) continue;
      if (item.pattern === undefined)
        throw new Error(
          "process update watches.items requires either index or pattern for remove mode",
        );
      normalizeLogMatchItems([{ ...item, pattern: item.pattern }], {
        actionLabel: "process update",
        pathPrefix: "watches.items",
      });
    }
  }
  registry.restore(params.id);
  if (!registry.get(params.id))
    registry.register(params.id, startNotify({ action: "start" }));
  if (
    watches?.mode === "append" &&
    (registry.getWatchState(params.id)?.logMatches.length ?? 0) +
      (watches.items?.length ?? 0) >
      MAX_LOG_MATCHERS_PER_PROCESS
  ) {
    throw new Error(
      `process update watches would exceed maximum of ${MAX_LOG_MATCHERS_PER_PROCESS} matchers`,
    );
  }
  return prepared;
}

export function finishUpdate(
  original: ProcessesParamsType,
  prepared: PreparedUpdate,
  details: UpdateDetails,
  registry: NotificationRegistry,
): UpdateDetails {
  if (!details.ok || !original.id) return details;
  const patch = { ...original.notify };
  applyLegacyAlerts(patch, original);
  const notify = registry.updateNotify(original.id, patch);
  if (notify) details.notify = notify;
  if (prepared.legacyMode) {
    let start = 0;
    if (prepared.legacyMode === "append") start = details.watches.before.length;
    registry.markLegacyWatches(
      original.id,
      details.watches.items.map((_, index) => index).slice(start),
    );
  }
  if (prepared.replay && prepared.replay.tailLines > 0) {
    let start = 0;
    if (prepared.replay.mode === "append")
      start = details.watches.before.length;
    const indexes = details.watches.items.map((_, index) => index).slice(start);
    details.replayMatches = registry.replayWatches(
      original.id,
      indexes,
      prepared.replay.tailLines,
      prepared.replay.maxMatches,
    );
  }
  details.legacyWatches = registry.getWatchInfo(original.id);
  return details;
}
