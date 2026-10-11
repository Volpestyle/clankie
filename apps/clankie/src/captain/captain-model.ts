import { type ModelPurpose, type PiModelSelection } from "@clankie/model-provider";
import { type CaptainSessionLaneV2 } from "@clankie/protocol";
import { type InlineExtension } from "@earendil-works/pi-coding-agent";
import { TurnModelUsageSchema, type TurnModelUsage } from "@clankie/protocol/model-keys";

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
  if (model.provider === "clankie")
    return [
      "## This turn's requested model",
      `The included route is \`${ref}\`. This names a requested route, not the provider/model actually serving it.`,
      "Authenticated provider response observations identify the serving model, including fallback. Missing observations mean unknown; never claim this alias is an actual model.",
    ].join("\n");
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

/** Response observations are session-local, reset before every provider attempt. */
export function captainModelUsageExtension(observation: { used?: TurnModelUsage }) {
  return {
    name: "captain-model-usage",
    hidden: true,
    factory(pi) {
      pi.on("before_provider_request", (_event, context) => {
        const model = context.model;
        if (model === undefined) {
          delete observation.used;
          return;
        }
        observation.used = {
          requestedRef: `${model.provider}/${model.id}`,
          actual:
            model.provider === "clankie"
              ? null
              : {
                  providerId: model.provider,
                  providerName: model.provider,
                  modelId: model.id,
                  modelName: model.name,
                },
          source: model.provider === "clankie" ? "unavailable" : "runtime",
        };
      });
      pi.on("after_provider_response", (event) => {
        if (
          observation.used?.requestedRef.startsWith("clankie/") !== true ||
          event.status < 200 ||
          event.status >= 300
        )
          return;
        const providerId = event.headers["x-clankie-model-provider"];
        const modelId = event.headers["x-clankie-model-id"];
        const parsed = TurnModelUsageSchema.safeParse({
          requestedRef: observation.used.requestedRef,
          actual: { providerId, providerName: providerId, modelId, modelName: modelId },
          source: "hosted_proxy",
        });
        if (parsed.success) observation.used = parsed.data;
      });
    },
  } satisfies InlineExtension;
}
