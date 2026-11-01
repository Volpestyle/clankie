import { createHash, randomUUID } from "node:crypto";
import type { DiscordTurnReceipts } from "./captain/discord-turn-receipts.ts";
import {
  DiscordCaptainActionInputSchema,
  DiscordCaptainActionResultSchema,
  type DiscordCaptainActionResult,
} from "@clankie/protocol";
import { postToDiscordActiveBody } from "./discord-active-body.ts";
import { DISCORD_BODY_UNREACHABLE_MESSAGE, type DiscordActionPort } from "./ports/discord.ts";

export { DISCORD_BODY_UNREACHABLE_MESSAGE };

export function createDiscordCaptainActionClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  receipts?: DiscordTurnReceipts,
): DiscordActionPort {
  return {
    serverAction: async (input) => {
      try {
        const response = await postToDiscordActiveBody(
          "/captain-action",
          DiscordCaptainActionInputSchema.parse({
            ...input,
            action: "server_action",
            callId: randomUUID(),
            source: "operator",
          }),
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
    execute: async (input, guard) => {
      try {
        if (guard !== undefined) {
          if (receipts === undefined) throw new Error("Discord guarded delivery unavailable");
          await guard();
          receipts.requireGuard(
            `captain:${input.callId}:${input.action}`,
            createHash("sha256").update(JSON.stringify(input)).digest("hex"),
            guard,
          );
        }
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
  return { ok: false, message: DISCORD_BODY_UNREACHABLE_MESSAGE };
}
