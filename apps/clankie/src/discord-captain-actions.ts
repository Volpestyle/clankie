import { createHash } from "node:crypto";
import type { DiscordTurnReceipts } from "./captain/discord-turn-receipts.ts";
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
  receipts?: DiscordTurnReceipts,
): {
  execute(input: DiscordCaptainActionInput, guard?: () => Promise<void>): Promise<DiscordCaptainActionResult>;
} {
  return {
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
  return { ok: false, message: "I can't reach my live Discord body for that action." };
}
