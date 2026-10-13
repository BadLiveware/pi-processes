import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import { LINE_MATCH_MODES } from "../../../src/utils/match-line";
import { PROCESS_PROTOCOL_ATTENTIONS } from "../../shared/protocol";
import type { LegacyWatchInfo, ReplayMatch } from "../tools/legacy/schema";
import {
  MAX_LOG_MATCH_PATTERN_LENGTH,
  MAX_LOG_MATCHERS_PER_PROCESS,
} from "./log-matchers";

export const LOG_MATCH_STREAMS = ["stdout", "stderr", "both"] as const;

export const LogMatcherConfigSchema = Type.Object({
  pattern: Type.String({
    maxLength: MAX_LOG_MATCH_PATTERN_LENGTH,
    description:
      "Log pattern to match. Limited to 500 characters. Literal by default; regex only when mode is regex.",
  }),
  mode: Type.Optional(
    StringEnum(LINE_MATCH_MODES, {
      description: "Pattern matching mode. Defaults to literal.",
    }),
  ),
  stream: Type.Optional(
    StringEnum(LOG_MATCH_STREAMS, {
      description: "Output stream to inspect. Defaults to both.",
    }),
  ),
  repeat: Type.Optional(
    Type.Boolean({
      description:
        "Whether this matcher can notify more than once. Defaults to false.",
    }),
  ),
  on: Type.Optional(
    StringEnum(PROCESS_PROTOCOL_ATTENTIONS, {
      description: "Agent attention for this log match. Defaults to turn.",
    }),
  ),
});

export type LogMatcherConfig = Static<typeof LogMatcherConfigSchema>;

export const NotifyConfigSchema = Type.Object({
  onSuccess: Type.Optional(
    StringEnum(PROCESS_PROTOCOL_ATTENTIONS, {
      description: "Attention on clean exit. Defaults to turn.",
    }),
  ),
  onFailure: Type.Optional(
    StringEnum(PROCESS_PROTOCOL_ATTENTIONS, {
      description: "Attention on failure or crash. Defaults to turn.",
    }),
  ),
  onKilled: Type.Optional(
    StringEnum(PROCESS_PROTOCOL_ATTENTIONS, {
      description: "Attention on external kill. Defaults to context.",
    }),
  ),
  logMatches: Type.Optional(
    Type.Array(LogMatcherConfigSchema, {
      maxItems: MAX_LOG_MATCHERS_PER_PROCESS,
      description:
        "Log match notifications. Supports at most 20 matchers, with each pattern limited to 500 characters.",
    }),
  ),
});

export type NotifyConfig = Static<typeof NotifyConfigSchema>;

export interface WatchMeta {
  revision: number;
  generation: number;
}

export interface WatchState {
  logMatches: LogMatcherConfig[];
  revision: number;
  generation: number;
}

export interface WatchRemoveSpec {
  index?: number;
  pattern?: string;
  mode?: LogMatcherConfig["mode"];
  stream?: LogMatcherConfig["stream"];
  repeat?: LogMatcherConfig["repeat"];
  on?: LogMatcherConfig["on"];
}

export interface WatchUpdateResult {
  logMatches: LogMatcherConfig[];
  revision: number;
  generation: number;
}

export interface WatchRuntime {
  info: (processId: string) => LegacyWatchInfo[];
  replay: (
    processId: string,
    indexes: number[],
    tailLines: number,
    maxMatches: number,
  ) => ReplayMatch[];
}

export interface NotificationRegistry {
  setWatchRuntime(runtime: WatchRuntime | null): void;
  getWatchInfo(processId: string): LegacyWatchInfo[];
  getWatchIds(processId: string): number[];
  getLegacyWatchIds(processId: string): number[];
  markLegacyWatches(processId: string, positions: number[]): void;
  replayWatches(
    processId: string,
    indexes: number[],
    tailLines: number,
    maxMatches: number,
  ): ReplayMatch[];
  restore(processId: string): void;
  forget(processId: string): void;
  prune(processIds: Set<string>): void;
  updateNotify(processId: string, patch: NotifyConfig): NotifyConfig | null;
  register(processId: string, config: NotifyConfig): void;
  unregister(processId: string): void;
  get(processId: string): NotifyConfig | null;
  getRetainedNotify(processId: string): NotifyConfig | null;
  getRetainedWatchState(processId: string): WatchState | null;
  markIntentionalStop(processId: string): void;
  consumeIntentionalStop(processId: string): boolean;
  clear(): void;
  appendWatches(
    processId: string,
    items: LogMatcherConfig[],
  ): WatchUpdateResult | null;
  replaceWatches(
    processId: string,
    items: LogMatcherConfig[],
  ): WatchUpdateResult | null;
  removeWatches(
    processId: string,
    specs: WatchRemoveSpec[],
  ): WatchUpdateResult | null;
  clearWatches(processId: string): WatchUpdateResult | null;
  getWatchState(processId: string): WatchState | null;
}

export function createNotificationRegistry(): NotificationRegistry {
  const configs = new Map<string, NotifyConfig>();
  const archived = new Map<string, { config: NotifyConfig; meta: WatchMeta }>();
  let runtime: WatchRuntime | null = null;
  const intentionalStops = new Set<string>();
  const watchMeta = new Map<string, WatchMeta>();
  const watchIds = new Map<string, number[]>();
  const nextWatchId = new Map<string, number>();
  const legacyWatchIds = new Map<string, Set<number>>();

  function allocateWatchIds(processId: string, count: number): number[] {
    const next = nextWatchId.get(processId) ?? 0;
    nextWatchId.set(processId, next + count);
    return Array.from({ length: count }, (_, index) => next + index);
  }

  function currentMatches(processId: string): LogMatcherConfig[] {
    const config = configs.get(processId);
    return config?.logMatches?.map((m) => ({ ...m })) ?? [];
  }

  function setMatches(processId: string, matches: LogMatcherConfig[]): void {
    const config = configs.get(processId);
    if (config) {
      config.logMatches = matches;
    }
  }

  function bumpRevision(processId: string, bumpGeneration: boolean): WatchMeta {
    const meta = watchMeta.get(processId) ?? { revision: 0, generation: 0 };
    meta.revision++;
    if (bumpGeneration) {
      meta.generation++;
    }
    watchMeta.set(processId, meta);
    return meta;
  }

  return {
    setWatchRuntime(value) {
      runtime = value;
    },
    getWatchIds(processId) {
      return [...(watchIds.get(processId) ?? [])];
    },
    getLegacyWatchIds(processId) {
      return [...(legacyWatchIds.get(processId) ?? [])];
    },
    markLegacyWatches(processId, positions) {
      const ids = watchIds.get(processId) ?? [];
      const legacy = legacyWatchIds.get(processId) ?? new Set<number>();
      for (const position of positions) {
        const id = ids[position];
        if (id !== undefined) legacy.add(id);
      }
      legacyWatchIds.set(processId, legacy);
      bumpRevision(processId, false);
    },
    getWatchInfo(processId) {
      if (runtime) return runtime.info(processId);
      return (this.getRetainedWatchState(processId)?.logMatches ?? []).map(
        (watch, index) => ({
          index: watchIds.get(processId)?.[index] ?? index,
          pattern: watch.pattern,
          stream: watch.stream ?? "both",
          repeat: watch.repeat ?? false,
          fired: false,
        }),
      );
    },
    replayWatches(processId, indexes, tailLines, maxMatches) {
      return runtime?.replay(processId, indexes, tailLines, maxMatches) ?? [];
    },
    restore(processId) {
      const item = archived.get(processId);
      if (!item) return;
      configs.set(processId, item.config);
      watchMeta.set(processId, item.meta);
      archived.delete(processId);
    },
    forget(processId) {
      configs.delete(processId);
      archived.delete(processId);
      watchMeta.delete(processId);
      watchIds.delete(processId);
      nextWatchId.delete(processId);
      legacyWatchIds.delete(processId);
      intentionalStops.delete(processId);
    },
    prune(processIds) {
      for (const id of [...configs.keys(), ...archived.keys()]) {
        if (!processIds.has(id)) this.forget(id);
      }
    },
    updateNotify(processId, patch) {
      const config = configs.get(processId);
      if (!config) return null;
      for (const field of ["onSuccess", "onFailure", "onKilled"] as const) {
        if (patch[field] !== undefined) config[field] = patch[field];
      }
      return config;
    },
    register(processId: string, config: NotifyConfig): void {
      archived.delete(processId);
      configs.set(processId, config);
      watchMeta.set(processId, { revision: 0, generation: 0 });
      nextWatchId.set(processId, 0);
      legacyWatchIds.delete(processId);
      watchIds.set(
        processId,
        allocateWatchIds(processId, config.logMatches?.length ?? 0),
      );
    },

    unregister(processId: string): void {
      const config = configs.get(processId);
      if (config)
        archived.set(processId, {
          config,
          meta: watchMeta.get(processId) ?? { revision: 0, generation: 0 },
        });
      configs.delete(processId);
      intentionalStops.delete(processId);
      watchMeta.delete(processId);
    },

    get(processId: string): NotifyConfig | null {
      return configs.get(processId) ?? null;
    },
    getRetainedNotify(processId) {
      const config = configs.get(processId) ?? archived.get(processId)?.config;
      if (!config) return null;
      return {
        ...config,
        logMatches: config.logMatches?.map((watch) => ({ ...watch })),
      };
    },
    getRetainedWatchState(processId) {
      const config = this.getRetainedNotify(processId);
      if (!config) return null;
      const meta = watchMeta.get(processId) ??
        archived.get(processId)?.meta ?? { revision: 0, generation: 0 };
      return { logMatches: config.logMatches ?? [], ...meta };
    },

    markIntentionalStop(processId: string): void {
      intentionalStops.add(processId);
    },

    consumeIntentionalStop(processId: string): boolean {
      return intentionalStops.delete(processId);
    },

    clear(): void {
      configs.clear();
      archived.clear();
      intentionalStops.clear();
      watchMeta.clear();
      watchIds.clear();
      nextWatchId.clear();
      legacyWatchIds.clear();
    },

    appendWatches(
      processId: string,
      items: LogMatcherConfig[],
    ): WatchUpdateResult | null {
      if (!configs.has(processId)) return null;
      const existing = currentMatches(processId);
      const merged = [...existing, ...items];
      if (merged.length > MAX_LOG_MATCHERS_PER_PROCESS) {
        throw new Error(
          `process update watches would exceed maximum of ${MAX_LOG_MATCHERS_PER_PROCESS} matchers`,
        );
      }
      setMatches(processId, merged);
      watchIds.set(processId, [
        ...(watchIds.get(processId) ?? []),
        ...allocateWatchIds(processId, items.length),
      ]);
      const meta = bumpRevision(processId, false);
      return {
        logMatches: merged,
        revision: meta.revision,
        generation: meta.generation,
      };
    },

    replaceWatches(
      processId: string,
      items: LogMatcherConfig[],
    ): WatchUpdateResult | null {
      if (!configs.has(processId)) return null;
      if (items.length > MAX_LOG_MATCHERS_PER_PROCESS) {
        throw new Error(
          `process update watches would exceed maximum of ${MAX_LOG_MATCHERS_PER_PROCESS} matchers`,
        );
      }
      setMatches(processId, [...items]);
      watchIds.set(processId, allocateWatchIds(processId, items.length));
      legacyWatchIds.delete(processId);
      const meta = bumpRevision(processId, true);
      return {
        logMatches: [...items],
        revision: meta.revision,
        generation: meta.generation,
      };
    },

    removeWatches(
      processId: string,
      specs: WatchRemoveSpec[],
    ): WatchUpdateResult | null {
      if (!configs.has(processId)) return null;
      const existing = currentMatches(processId);
      const filtered = existing.filter(
        (matcher, index) => !matchesRemoveSpec(matcher, index, specs),
      );
      const ids = watchIds.get(processId) ?? [];
      watchIds.set(
        processId,
        ids.filter(
          (_, index) => !matchesRemoveSpec(existing[index], index, specs),
        ),
      );
      const remainingIds = new Set(watchIds.get(processId));
      const legacy = legacyWatchIds.get(processId);
      if (legacy)
        for (const id of legacy) {
          if (!remainingIds.has(id)) legacy.delete(id);
        }
      setMatches(processId, filtered);
      const meta = bumpRevision(processId, false);
      return {
        logMatches: filtered,
        revision: meta.revision,
        generation: meta.generation,
      };
    },

    clearWatches(processId: string): WatchUpdateResult | null {
      if (!configs.has(processId)) return null;
      setMatches(processId, []);
      watchIds.set(processId, []);
      legacyWatchIds.delete(processId);
      const meta = bumpRevision(processId, true);
      return {
        logMatches: [],
        revision: meta.revision,
        generation: meta.generation,
      };
    },

    getWatchState(processId: string): WatchState | null {
      if (!configs.has(processId)) return null;
      const meta = watchMeta.get(processId) ?? { revision: 0, generation: 0 };
      return {
        logMatches: currentMatches(processId),
        revision: meta.revision,
        generation: meta.generation,
      };
    },
  };
}

function matchesRemoveSpec(
  matcher: LogMatcherConfig,
  index: number,
  specs: WatchRemoveSpec[],
): boolean {
  return specs.some((spec) => {
    if (spec.index !== undefined) return spec.index === index;
    if (!spec.pattern) return false;
    if (matcher.pattern !== spec.pattern) return false;
    if (spec.mode !== undefined && (matcher.mode ?? "literal") !== spec.mode)
      return false;
    if (spec.stream !== undefined && (matcher.stream ?? "both") !== spec.stream)
      return false;
    if (spec.repeat !== undefined && (matcher.repeat ?? false) !== spec.repeat)
      return false;
    if (spec.on !== undefined && (matcher.on ?? "turn") !== spec.on)
      return false;
    return true;
  });
}
