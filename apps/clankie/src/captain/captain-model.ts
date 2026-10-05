import { type ModelPurpose, type PiModelSelection } from "@clankie/model-provider";
import { type CaptainSessionLaneV2 } from "@clankie/protocol";
import { type InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Which kind of model call a session makes, for task-based routing. A Discord
 * session's machine tools are fixed when it is built, so its purpose is too.
 */
export function sessionPurpose(lane: CaptainSessionLaneV2, systemTools: boolean): ModelPurpose {
  if (lane === "operator") return "operator";
  if (lane === "gameplay") return "gameplay";
  return systemTools ? "discord_granted" : "discord_social";
}

/** 272000 -> "272k": a size he can say out loud, not an exact accounting. */
function formatTokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

/** What he is running on, in his own words. */
export function modelCard({ model, thinkingLevel, ref }: PiModelSelection): string {
  return [
    "## The model you are running on",
    `${model.name} (\`${ref}\`), served by ${model.provider}.`,
    `${model.reasoning ? `Reasoning model, effort ${thinkingLevel}.` : "No reasoning."} Context window ${formatTokens(model.contextWindow)} tokens, up to ${formatTokens(model.maxTokens)} out. Takes ${model.input.join(" and ")}.`,
    "This is a fact about you: say it plainly when asked. The operator changes it with `/model` and `/effort`, so read it here rather than from what you remember.",
  ].join("\n");
}

/**
 * His own substrate, refreshed per run rather than baked into the session
 * prompt — `/model` and `/effort` swap it under a live session, and a
 * remembered answer would be a confident lie the day after a switch. A
 * resolve failure stays silent: he goes back to not knowing, he never guesses.
 */
export function captainModelExtension(resolveSelection: () => Promise<PiModelSelection>) {
  return {
    name: "captain-model",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", async (event) => {
        const selection = await resolveSelection().catch(() => undefined);
        if (selection === undefined) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${modelCard(selection)}` };
      });
    },
  } satisfies InlineExtension;
}
