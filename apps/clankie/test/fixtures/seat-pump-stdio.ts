import { z } from "zod";
import {
  OperatorConversationIdSchema,
  OPERATOR_SEAT_CAPABILITIES_HEADER,
  OPERATOR_CONVERSATION_REF_MAX,
  OPERATOR_CONVERSATION_CODE_MAX,
  OPERATOR_CONVERSATION_TEXT_MAX,
} from "@clankie/protocol";
import { connectLaneUpstream, runMcpCommand } from "../../../tui/src/command/mcp.ts";

const [host, mode] = process.argv.slice(2);
if (!host) throw new Error("Owned seat-pump fixture requires its HTTP host");
// A real stdio bridge and credential override against an owned HTTP service.
// The SDK client is a transport test peer; this does not claim Claude delivery.
process.exitCode = await runMcpCommand(["--lane", "operator", "--conversation", "global-default"], {
  host,
  ...(mode === "legacy"
    ? {
        connectUpstream: async () =>
          connectLaneUpstream({
            host,
            bearer: process.env.CLANKIE_OPERATOR_TOKEN!,
            fetchImpl: async (input, init) => {
              const headers = new Headers(init?.headers);
              headers.delete(OPERATOR_SEAT_CAPABILITIES_HEADER);
              const response = await fetch(input, { ...init, headers });
              if (new URL(String(input)).pathname === "/v1/seat/events" && response.ok) {
                // Exact Oct 6 wire contract: no turn, ownerOrigin, or other extra fields.
                const event = z
                  .object({
                    schemaVersion: z.literal(1),
                    id: z.string().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
                    kind: z.enum(["wake", "watch", "escalation", "message"]),
                    conversationId: OperatorConversationIdSchema,
                    source: z.string().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
                    content: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
                    createdAt: z.string().min(1),
                  })
                  .strict();
                z.object({ schemaVersion: z.literal(1), events: z.array(event).max(64) })
                  .strict()
                  .parse(await response.clone().json());
              }
              return response;
            },
          }),
      }
    : {}),
  pollWaitMs: 50,
  pollRetryMs: 5,
  readParentArgv: async () => "claude --dangerously-load-development-channels plugin:clankie@inline",
});
