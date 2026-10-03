import { DiscordVoiceOutputControlSchema } from "@clankie/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DiscordVoiceSessionStatus } from "./voice-session.ts";

export interface VoiceOutputControlPort {
  status(): DiscordVoiceSessionStatus | undefined;
  setOutputMuted(stayId: string, muted: boolean, guard: () => Promise<void>): Promise<void>;
  leave(stayId: string, guard: () => Promise<void>): Promise<void>;
  authorize(input: {
    nonce: string;
    stayId: string;
    action: "mute_output" | "unmute_output" | "leave";
  }): Promise<void>;
}
/** Loopback host control. A nonce alone is inert; the captain authenticates the body's final callback. */
export function tryHandleVoiceOutputControl(
  request: IncomingMessage,
  response: ServerResponse,
  port: VoiceOutputControlPort,
): boolean {
  if (request.method !== "POST" || (request.url !== "/voice/status" && request.url !== "/voice/output"))
    return false;
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
  });
  request.on("end", () => {
    void (async () => {
      try {
        if (size > 4096) throw Error("invalid_voice_control");
        if (request.url === "/voice/output") {
          const command = DiscordVoiceOutputControlSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          if (command.action === "leave") await port.leave(command.stayId, () => port.authorize(command));
          else
            await port.setOutputMuted(command.stayId, command.action === "mute_output", () =>
              port.authorize(command),
            );
        }
        const status = port.status();
        response.writeHead(status === undefined ? 503 : 200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(status ?? { error: "voice_unavailable" }));
      } catch {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "voice_control_refused" }));
      }
    })();
  });
  return true;
}
