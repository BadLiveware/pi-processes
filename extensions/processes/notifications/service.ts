import type { EventBus } from "@earendil-works/pi-coding-agent";

import type { ProcessManager } from "../../../src/manager";
import type { ManagerEvent, ProcessInfo } from "../../../src/types";
import { CHANNELS } from "../../shared/protocol";
import type { ReplayMatch } from "../tools/legacy/schema";
import { classifyProcessEnd } from "./classify";
import { groupNotification } from "./groups";
import {
  type CompiledLogMatcher,
  compileLogMatchers,
  evaluateLogMatchers,
  type LogMatchResult,
} from "./log-matchers";
import type { NotifyConfig, WatchState } from "./registry";
import {
  createNotificationRegistry,
  type NotificationRegistry,
} from "./registry";
import type {
  Attention,
  ProcessNotificationDetails,
  ProcessNotificationKind,
} from "./types";

const DEFAULT_ATTENTION: Record<
  "onSuccess" | "onFailure" | "onKilled",
  Attention
> = {
  // Keep in sync with DEFAULT_NOTIFY_CONFIG in tools/notify.ts. Success
  // defaults to a turn because "context" is only seen by an agent that is
  // still streaming when the process ends.
  onSuccess: "turn",
  onFailure: "turn",
  // External kills surface as context by default (see DEFAULT_NOTIFY_CONFIG
  // in tools/notify.ts for rationale). Intentional stops are classified
  // separately and never reach this branch.
  onKilled: "context",
};

export interface NotificationServiceDeps {
  /**
   * Event bus used to fan out notification events on CHANNELS.NOTIFICATION.
   * The service never calls pi.sendMessage directly; a core delivery listener
   * converts the emitted payload into a persisted custom message. This keeps
   * notification flow event-driven and lets UI extensions observe the same
   * events (e.g. for log-match highlighting).
   */
  events: EventBus;
  manager: ProcessManager;
  registry: NotificationRegistry;
  getProcess: (id: string) => ProcessInfo | null;
}

interface ProcessMatcherState {
  matchers: CompiledLogMatcher[];
  watchIds: number[];
  revision: number;
  generation: number;
}

export function createNotificationService(deps: NotificationServiceDeps): {
  dispose: () => void;
} {
  const { events, manager, registry, getProcess } = deps;
  let disposed = false;
  const matcherStates = new Map<string, ProcessMatcherState>();

  const unsubscribe = manager.onEvent(handleEvent);
  registry.setWatchRuntime({
    info(processId) {
      const watchState = registry.getRetainedWatchState(processId);
      if (!watchState) return [];
      const state = syncMatcherState(processId, watchState);
      const ids = registry.getWatchIds(processId);
      return watchState.logMatches.map((watch, index) => ({
        index: ids[index] ?? index,
        pattern: watch.pattern,
        stream: watch.stream ?? "both",
        repeat: watch.repeat ?? false,
        fired:
          state?.matchers.find((matcher) => matcher.matcherIndex === index)
            ?.fired ?? false,
      }));
    },
    replay(processId, indexes, tailLines, maxMatches) {
      const watchState = registry.getWatchState(processId);
      if (!watchState || tailLines === 0 || maxMatches === 0) return [];
      const state = syncMatcherState(processId, watchState);
      if (!state) return [];
      const selected = state.matchers.filter((matcher) =>
        indexes.includes(matcher.matcherIndex),
      );
      const output = manager.getOutput(processId, tailLines);
      if (!output) return [];
      const lines = [
        ...output.stdout.map((text) => ({ type: "stdout" as const, text })),
        ...output.stderr.map((text) => ({ type: "stderr" as const, text })),
      ];
      const result: ReplayMatch[] = [];
      const ids = registry.getWatchIds(processId);
      for (const line of lines) {
        if (result.length >= maxMatches) break;
        for (const matcher of selected) {
          if (result.length >= maxMatches) break;
          let replayMatcher = matcher;
          if (matcher.repeat)
            replayMatcher = { ...matcher, fired: false, lastMatchTime: 0 };
          const matches = evaluateLogMatchers(
            [replayMatcher],
            [line],
            performance.now(),
          );
          for (const match of matches) {
            result.push({
              watchIndex: ids[match.matcherIndex] ?? match.matcherIndex,
              pattern: match.pattern,
              source: match.stream,
              line: match.line,
            });
          }
        }
      }
      return result;
    },
  });

  function handleEvent(event: ManagerEvent): void {
    if (disposed) return;

    if (event.type === "process_group_monitor_triggered") {
      events.emit(CHANNELS.NOTIFICATION, groupNotification(event.group));
      return;
    }
    if (event.type === "processes_changed") {
      const ids = new Set(manager.list().map((info) => info.id));
      registry.prune(ids);
      for (const id of matcherStates.keys()) {
        if (!ids.has(id)) cleanupMatcherState(id);
      }
      return;
    }
    if (event.type === "process_ended") {
      const grouped = manager.hasTurnGroupForProcess(event.info.id);
      // Defer to a microtask so that tool code (e.g. executeStart) can
      // register the notify config in the registry before we read it.
      // manager.start() may synchronously emit process_ended for missing_pid.
      queueMicrotask(() => {
        if (disposed) return;
        handleProcessEnded(event.info, grouped);
      });
      return;
    }

    if (event.type === "process_output_changed") {
      handleOutputChanged(event);
      return;
    }
  }

  function handleProcessEnded(info: ProcessInfo, grouped: boolean): void {
    const isIntentionalStop = registry.consumeIntentionalStop(info.id);
    const kind = classifyProcessEnd(info);

    if (isIntentionalStop) {
      const details = buildLifecycleDetails(info, kind, "context");
      events.emit(CHANNELS.NOTIFICATION, details);

      registry.unregister(info.id);
      return;
    }

    const config = registry.get(info.id);
    let attention = resolveAttention(kind, config);
    if (
      (grouped || manager.hasTurnGroupForProcess(info.id)) &&
      attention === "turn"
    )
      attention = "context";

    const shouldForceDisplay = kind === "crash" || kind === "failure";

    if (attention === "ignore" && !shouldForceDisplay) {
      registry.unregister(info.id);
      return;
    }

    const effectiveAttention: Attention =
      attention === "ignore" && shouldForceDisplay ? "context" : attention;

    const details = buildLifecycleDetails(info, kind, effectiveAttention);
    events.emit(CHANNELS.NOTIFICATION, details);

    registry.unregister(info.id);
  }

  function handleOutputChanged(
    event: ManagerEvent & { type: "process_output_changed" },
  ): void {
    if (!event.appendedText || event.appendedText.length === 0) return;

    const watchState = registry.getWatchState(event.id);
    if (!watchState) return;

    const state = syncMatcherState(event.id, watchState);
    if (!state) return;

    const matchTime = performance.now();
    const matches = evaluateLogMatchers(
      state.matchers,
      event.appendedText,
      matchTime,
    );

    for (const match of matches) emitLogMatch(event.id, match);
  }

  function emitLogMatch(id: string, match: LogMatchResult): void {
    events.emit(
      CHANNELS.NOTIFICATION,
      buildLogMatchDetails(id, getProcess(id), match, match.on, Date.now()),
    );
  }

  function resolveAttention(
    kind: ProcessNotificationKind,
    config: NotifyConfig | null,
  ): Attention {
    switch (kind) {
      case "success":
        return config?.onSuccess ?? DEFAULT_ATTENTION.onSuccess;
      case "failure":
      case "crash":
        return config?.onFailure ?? DEFAULT_ATTENTION.onFailure;
      case "killed":
        return config?.onKilled ?? DEFAULT_ATTENTION.onKilled;
      case "log_match":
        return "turn";
      case "log_match_suppressed":
      case "group_monitor":
        return "context";
    }
  }

  function buildLifecycleDetails(
    info: ProcessInfo,
    kind: ProcessNotificationKind,
    attention: Attention,
  ): ProcessNotificationDetails {
    const elapsed =
      info.endTime !== null && info.startTime > 0
        ? Math.round((info.endTime - info.startTime) / 1000)
        : null;

    let summary: string;
    if (kind === "success") {
      summary =
        elapsed !== null
          ? `Process "${info.name}" succeeded after ${elapsed}s.`
          : `Process "${info.name}" succeeded.`;
    } else if (kind === "killed" && info.signal) {
      const number =
        info.signal.number === null
          ? ""
          : ` (${info.signal.number}, ${info.signal.description})`;
      summary = `Process "${info.name}" ended after receiving ${info.signal.name}${number}.`;
    } else if (info.exitCode !== null && info.exitCode !== 0) {
      summary =
        elapsed !== null
          ? `Process "${info.name}" failed with exit code ${info.exitCode} after ${elapsed}s.`
          : `Process "${info.name}" failed with exit code ${info.exitCode}.`;
    } else {
      summary = `Process "${info.name}" failed.`;
    }

    return {
      kind,
      processId: info.id,
      processName: info.name,
      command: info.command,
      timestamp: info.endTime ?? Date.now(),
      summary,
      status: info.status,
      exitCode: info.exitCode,
      endReason: info.endReason,
      signal: info.signal,
      attention,
    };
  }

  function buildLogMatchDetails(
    processId: string,
    processInfo: ProcessInfo | null,
    match: LogMatchResult,
    attention: Attention,
    timestamp: number,
  ): ProcessNotificationDetails {
    const name = processInfo?.name ?? processId;
    const command = processInfo?.command ?? "";
    const truncatedLine =
      match.line.length > 160 ? `${match.line.slice(0, 157)}...` : match.line;

    return {
      kind: "log_match",
      processId,
      processName: name,
      command,
      timestamp,
      summary: `Process "${name}" matched log pattern "${match.pattern}" on ${match.stream}.`,
      logMatch: {
        pattern: match.pattern,
        mode: match.mode,
        stream: match.stream,
        line: truncatedLine,
        matcherIndex: match.matcherIndex,
      },
      attention,
    };
  }

  function syncMatcherState(
    processId: string,
    watchState: WatchState,
  ): ProcessMatcherState | null {
    const existing = matcherStates.get(processId);
    if (existing?.revision === watchState.revision) return existing;
    const ids = registry.getWatchIds(processId);
    const legacyIds = new Set(registry.getLegacyWatchIds(processId));
    const legacyIndexes = new Set(
      ids
        .map((id, index) => ({ id, index }))
        .filter((entry) => legacyIds.has(entry.id))
        .map((entry) => entry.index),
    );

    if (!existing) {
      const matchers = compileLogMatchers(
        { logMatches: watchState.logMatches },
        legacyIndexes,
      );
      if (matchers.length === 0) return null;
      const state: ProcessMatcherState = {
        matchers,
        watchIds: [...ids],
        revision: watchState.revision,
        generation: watchState.generation,
      };
      matcherStates.set(processId, state);
      return state;
    }

    const next = compileLogMatchers(
      { logMatches: watchState.logMatches },
      legacyIndexes,
    );

    if (existing.generation === watchState.generation) {
      preserveMatcherRuntimeState(
        existing.matchers,
        next,
        existing.watchIds,
        ids,
      );
    }

    if (next.length === 0) {
      matcherStates.delete(processId);
      return null;
    }

    const state: ProcessMatcherState = {
      matchers: next,
      watchIds: [...ids],
      revision: watchState.revision,
      generation: watchState.generation,
    };
    matcherStates.set(processId, state);
    return state;
  }

  function preserveMatcherRuntimeState(
    prev: CompiledLogMatcher[],
    next: CompiledLogMatcher[],
    previousIds: number[],
    nextIds: number[],
  ): void {
    // Identical patterns can have independent fired/cooldown state. Match by
    // retained watch identity so a removed watch cannot consume its sibling.
    const byId = new Map<number, CompiledLogMatcher>();
    for (const matcher of prev) {
      const id = previousIds[matcher.matcherIndex];
      if (id !== undefined) byId.set(id, matcher);
    }

    for (const matcher of next) {
      const id = nextIds[matcher.matcherIndex];
      if (id === undefined) continue;
      const donor = byId.get(id);
      if (!donor || matcherIdentityKey(matcher) !== matcherIdentityKey(donor))
        continue;
      matcher.fired = donor.fired;
      matcher.lastMatchTime = donor.lastMatchTime;
    }
  }

  function matcherIdentityKey(m: {
    pattern: string;
    mode: string;
    stream: string;
    repeat: boolean;
    on: string;
    repeatEveryLine?: boolean;
  }): string {
    return JSON.stringify([
      m.pattern,
      m.mode,
      m.stream,
      m.repeat,
      m.on,
      m.repeatEveryLine,
    ]);
  }

  function cleanupMatcherState(processId: string): void {
    matcherStates.delete(processId);
  }

  return {
    dispose() {
      disposed = true;
      unsubscribe();
      matcherStates.clear();
      registry.setWatchRuntime(null);
    },
  };
}

export { createNotificationRegistry };
