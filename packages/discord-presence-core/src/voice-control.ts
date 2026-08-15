import type { DiscordVoicePresenceResult } from "@clankie/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";

export type VoicePresenceControlAction = "join" | "leave";

export interface VoicePresenceControlInput {
  readonly guildId: string;
  readonly actorId: string;
}

export function parseVoicePresenceControlPath(url: string): VoicePresenceControlAction | undefined {
  const action = /^\/voice\/(join|leave)$/u.exec(url.split("?")[0] ?? url)?.[1];
  return action === "join" || action === "leave" ? action : undefined;
}

/** Loopback `/voice/*` shared by both Discord bodies. */
export function tryHandleVoicePresenceControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  execute: (
    action: VoicePresenceControlAction,
    input: VoicePresenceControlInput,
  ) => Promise<DiscordVoicePresenceResult>,
): boolean {
  if (request.method !== "POST") return false;
  const action = parseVoicePresenceControlPath(request.url ?? "/");
  if (action === undefined) return false;
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    void (async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        const input = voicePresenceControlInput(body);
        const result = await execute(action, input);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_voice_presence_request" }));
      }
    })();
  });
  return true;
}

function voicePresenceControlInput(value: unknown): VoicePresenceControlInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_voice_presence_request");
  }
  const body = value as Record<string, unknown>;
  const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
  const actorId = typeof body.actorId === "string" ? body.actorId.trim() : "";
  if (guildId.length === 0 || guildId.length > 128 || actorId.length === 0 || actorId.length > 128) {
    throw new Error("invalid_voice_presence_request");
  }
  return { guildId, actorId };
}
