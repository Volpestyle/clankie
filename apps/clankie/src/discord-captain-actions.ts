import {
  DiscordCaptainActionInputSchema,
  DiscordCaptainActionResultSchema,
  type DiscordCaptainActionInput,
  type DiscordCaptainActionResult,
} from "@clankie/protocol";
import { resolveDiscordActiveBody } from "@clankie/settings";

export function createDiscordCaptainActionClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): {
  execute(input: DiscordCaptainActionInput): Promise<DiscordCaptainActionResult>;
} {
  return {
    execute: async (input) => {
      try {
        const port =
          resolveDiscordActiveBody(env) === "user_session"
            ? env.CLANKIE_USER_SESSION_CONTROL_PORT?.trim() || "4312"
            : env.CLANKIE_DISCORD_BRIDGE_CONTROL_PORT?.trim() || "4313";
        const response = await fetchImpl(`http://127.0.0.1:${port}/captain-action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(DiscordCaptainActionInputSchema.parse(input)),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return unavailable();
        const parsed = DiscordCaptainActionResultSchema.safeParse(await response.json());
        return parsed.success ? parsed.data : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}

function unavailable(): DiscordCaptainActionResult {
  return { ok: false, message: "I can't reach my live Discord body for that action." };
}
