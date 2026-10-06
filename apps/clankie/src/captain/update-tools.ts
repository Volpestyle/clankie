import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RuntimeUpdater } from "../../../tui/bin/runtime-updater.ts";
import { assertConversationAuthority, captureConversationAuthority } from "./conversation-owner.ts";
import { toolJson, type TurnContext } from "./tools.ts";

/** Created only for a host-admitted machine session; rechecks exact turn authority at use. */
export function runtimeUpdateTools(updater: RuntimeUpdater | undefined, turn: TurnContext): ToolDefinition[] {
  if (!updater || turn.shell !== true) return [];
  const authority = () => {
    if (turn.shell !== true) throw Error("Machine tools are unavailable for this turn");
    const source = captureConversationAuthority(turn.conversationAuthority);
    return {
      guard: () => assertConversationAuthority(source),
      current: source.current,
      initiator: { kind: "conversation" as const, conversationId: source.owner.conversationId },
    };
  };
  return [
    defineTool({
      name: "update_runtime",
      label: "Update Clankie",
      description:
        "Fetch and install origin/main (or an explicit branch, SHA or refs/tags/... ref), then detach a guarded restart. The result names the exact target commit and warns of rollback or divergence. Accepted means pending, not healthy. Read runtime_update_status on the next turn; never repeat an uncertain request.",
      parameters: Type.Object(
        { ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) },
        { additionalProperties: false },
      ),
      execute: async (_id, params) => toolJson(await updater.request(params.ref ?? "main", authority())),
    }),
    defineTool({
      name: "runtime_update_status",
      label: "Read update result",
      description:
        "Read this service's immutable boot identity and the durable last update, including old/new commit, service health and any rollback or uncertainty.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const source = authority();
        await source.guard();
        const result = updater.status();
        await source.guard();
        if (!source.current()) throw Error("Machine source changed");
        return toolJson(result);
      },
    }),
  ];
}
