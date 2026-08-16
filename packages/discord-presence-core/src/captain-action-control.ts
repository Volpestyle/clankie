import {
  DiscordCaptainActionInputSchema,
  DiscordCaptainActionResultSchema,
  type DiscordCaptainActionInput,
  type DiscordCaptainActionResult,
} from "@clankie/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Loopback `/captain-action` shared by both Discord bodies. */
export function tryHandleCaptainDiscordActionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  execute: (input: DiscordCaptainActionInput) => Promise<DiscordCaptainActionResult>,
): boolean {
  if (request.method !== "POST" || (request.url ?? "/").split("?")[0] !== "/captain-action") {
    return false;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    void (async () => {
      try {
        const input = DiscordCaptainActionInputSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        );
        const result = DiscordCaptainActionResultSchema.parse(await execute(input));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: "Invalid Discord action request." }));
      }
    })();
  });
  return true;
}
