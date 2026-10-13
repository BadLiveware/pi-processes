import { type Static, Type } from "typebox";
import { MAX_GROUP_PROCESS_IDS } from "../../../../src/manager/group-monitors";

export const GroupParamsProperties = {
  processIds: Type.Optional(
    Type.Array(Type.String(), { minItems: 1, maxItems: MAX_GROUP_PROCESS_IDS }),
  ),
  groupMode: Type.Optional(
    Type.Union([Type.Literal("all"), Type.Literal("any")]),
  ),
  failFast: Type.Optional(
    Type.Boolean({
      description:
        "In all mode, notify on the first failed or killed member. Defaults to true.",
    }),
  ),
  triggerTurn: Type.Optional(
    Type.Boolean({
      description:
        "Group owns member lifecycle wakes. Defaults to true; false leaves per-process wakes active.",
    }),
  ),
  groupId: Type.Optional(Type.String()),
};
export const GroupInfoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  processIds: Type.Array(Type.String()),
  mode: Type.Union([Type.Literal("all"), Type.Literal("any")]),
  failFast: Type.Boolean(),
  triggerTurn: Type.Boolean(),
  createdAt: Type.Number(),
  triggeredAt: Type.Union([Type.Number(), Type.Null()]),
  outcome: Type.Union([
    Type.Literal("all_succeeded"),
    Type.Literal("all_exited"),
    Type.Literal("any_succeeded"),
    Type.Literal("any_failed"),
    Type.Null(),
  ]),
  triggerProcessId: Type.Union([Type.String(), Type.Null()]),
  summary: Type.Object({
    total: Type.Integer(),
    running: Type.Integer(),
    succeeded: Type.Integer(),
    failed: Type.Integer(),
    killed: Type.Integer(),
  }),
});
function groupOutput<
  const Action extends "monitorGroup" | "listGroups" | "clearGroup",
>(action: Action) {
  return Type.Object({
    action: Type.Literal(action),
    success: Type.Boolean(),
    message: Type.String(),
    group: Type.Optional(GroupInfoSchema),
    groups: Type.Optional(Type.Array(GroupInfoSchema)),
  });
}
export const GroupOutputSchemas = [
  groupOutput("monitorGroup"),
  groupOutput("listGroups"),
  groupOutput("clearGroup"),
] as const;
export const GroupOutputSchema = Type.Union([...GroupOutputSchemas]);
export type GroupDetails = Static<typeof GroupOutputSchema>;
