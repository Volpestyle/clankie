import {
  DiscordCaptainActionInputSchema,
  DiscordCaptainActionResultSchema,
  type DiscordCaptainActionInput,
  type DiscordCaptainActionResult,
} from "@clankie/protocol";
import { postToDiscordActiveBody } from "./discord-active-body.ts";

export function createDiscordCaptainActionClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): {
  execute(input: DiscordCaptainActionInput): Promise<DiscordCaptainActionResult>;
} {
  return {
    execute: async (input) => {
      try {
        const response = await postToDiscordActiveBody(
          "/captain-action",
          DiscordCaptainActionInputSchema.parse(input),
          env,
          fetchImpl,
        );
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
