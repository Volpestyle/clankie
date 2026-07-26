import {
  captainLaneKind,
  type CaptainSessionLaneV2Address,
  type EveChannelLaneContext,
} from "@clankie/captain-runtime";

// Lane classification and instructions are the single shared definition in
// `@clankie/captain-runtime` (ADR 0057): the control plane composes the same
// lane identity into the realtime voice briefing that captain-eve composes into
// captain turns. Re-exported so every existing captain-eve import keeps working.
export {
  captainLaneInstructions,
  captainLaneKind,
  type EveChannelLaneContext,
} from "@clankie/captain-runtime";

export function captainLaneAddress(
  channel: EveChannelLaneContext,
  characterId: string,
): CaptainSessionLaneV2Address {
  const lane = captainLaneKind(channel);
  const explicitTarget = channel.metadata?.captainTargetId;
  const targetId =
    typeof explicitTarget === "string" && explicitTarget.trim().length > 0
      ? explicitTarget.trim()
      : lane === "operator"
        ? // The unscoped/direct operator channel is always the default global
          // conversation. Per-conversation targeting is carried by the authored
          // operator channel's `state.conversationId` -> `metadata.captainTargetId`
          // (see agent/channels/operator-conversations.ts), never a process-global
          // env var — so simultaneous surfaces stay isolated.
          "global-default"
        : undefined;
  if (targetId === undefined) {
    throw new Error(`${lane} Eve sessions require channel metadata.captainTargetId`);
  }
  return { characterId, lane, targetId };
}
