import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import {
  MAX_LOG_MATCH_PATTERN_LENGTH,
  MAX_LOG_MATCHERS_PER_PROCESS,
} from "../../notifications/log-matchers";

export const LegacyWatchSchema = Type.Object({
  pattern: Type.String({
    minLength: 1,
    maxLength: MAX_LOG_MATCH_PATTERN_LENGTH,
  }),
  stream: Type.Optional(
    Type.Union([
      Type.Literal("stdout"),
      Type.Literal("stderr"),
      Type.Literal("both"),
    ]),
  ),
  repeat: Type.Optional(Type.Boolean()),
});
export const LEGACY_WATCH_MODES = [
  "list",
  "append",
  "replace",
  "remove",
  "clear",
] as const;
const WatchModeSchema = StringEnum(LEGACY_WATCH_MODES);
export const MAX_REPLAY_TAIL_LINES = 10000;
export const MAX_REPLAY_MATCHES = 200;
export const DEFAULT_REPLAY_MATCHES = 20;
const ReplayProperties = {
  replayTailLines: Type.Optional(
    Type.Integer({ minimum: 0, maximum: MAX_REPLAY_TAIL_LINES }),
  ),
  maxReplayMatches: Type.Optional(
    Type.Integer({ minimum: 0, maximum: MAX_REPLAY_MATCHES }),
  ),
};
export const LegacyParamsProperties = {
  alertOnSuccess: Type.Optional(
    Type.Boolean({
      description: "Legacy exit wake flag. Defaults to false without notify.",
    }),
  ),
  alertOnFailure: Type.Optional(
    Type.Boolean({
      description: "Legacy failure wake flag. Defaults to true.",
    }),
  ),
  alertOnKill: Type.Optional(
    Type.Boolean({
      description:
        "Legacy external-kill wake flag. Defaults to false. Intentional stops never wake.",
    }),
  ),
  logWatches: Type.Optional(
    Type.Array(LegacyWatchSchema, { maxItems: MAX_LOG_MATCHERS_PER_PROCESS }),
  ),
  watchAction: Type.Optional(WatchModeSchema),
  watchIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
  ...ReplayProperties,
  logWatchUpdate: Type.Optional(
    Type.Object({
      mode: WatchModeSchema,
      watches: Type.Optional(
        Type.Array(LegacyWatchSchema, {
          maxItems: MAX_LOG_MATCHERS_PER_PROCESS,
        }),
      ),
      watchIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
      ...ReplayProperties,
    }),
  ),
};

export const ReplayMatchSchema = Type.Object({
  watchIndex: Type.Integer(),
  pattern: Type.String(),
  source: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
  line: Type.String(),
});
export type ReplayMatch = Static<typeof ReplayMatchSchema>;
export const LegacyWatchInfoSchema = Type.Object({
  index: Type.Integer(),
  pattern: Type.String(),
  stream: Type.Union([
    Type.Literal("stdout"),
    Type.Literal("stderr"),
    Type.Literal("both"),
  ]),
  repeat: Type.Boolean(),
  fired: Type.Boolean(),
});
export type LegacyWatchInfo = Static<typeof LegacyWatchInfoSchema>;

export const LogsOutputSchema = Type.Object({
  action: Type.Literal("logs"),
  id: Type.String(),
  processName: Type.String(),
  logFiles: Type.Object({
    stdoutFile: Type.String(),
    stderrFile: Type.String(),
    combinedFile: Type.String(),
  }),
});
export type LogsDetails = Static<typeof LogsOutputSchema>;
