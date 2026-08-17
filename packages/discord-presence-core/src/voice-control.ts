import type { DiscordVoicePresenceResult } from "@clankie/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";

export type VoicePresenceControlAction = "join" | "leave";

export interface VoicePresenceControlInput {
  /** Absent on an operator follow: the body locates the configured owner. */
  readonly guildId?: string;
  /** Absent on an operator follow; required when `guildId` is present. */
  readonly actorId?: string;
}

export interface OwnerVoiceCandidate {
  readonly guildId: string;
  readonly channelId: string;
}

export type OwnerFollowTarget =
  | { readonly outcome: "found"; readonly guildId: string; readonly channelId: string }
  | { readonly outcome: "none" }
  | { readonly outcome: "ambiguous" };

/** Pick the owner's current allowlisted voice channel without asking the model. */
export function resolveOwnerFollowTarget(
  candidates: readonly OwnerVoiceCandidate[],
  active?: { readonly active: boolean; readonly guildId?: string; readonly channelId?: string },
): OwnerFollowTarget {
  if (candidates.length === 0) return { outcome: "none" };
  const first = candidates[0];
  if (candidates.length === 1 && first !== undefined) {
    return { outcome: "found", guildId: first.guildId, channelId: first.channelId };
  }
  if (active?.active === true && active.guildId !== undefined && active.channelId !== undefined) {
    const current = candidates.find(
      (candidate) => candidate.guildId === active.guildId && candidate.channelId === active.channelId,
    );
    if (current !== undefined) {
      return { outcome: "found", guildId: current.guildId, channelId: current.channelId };
    }
  }
  return { outcome: "ambiguous" };
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
  const guildId = optionalControlId(body.guildId);
  const actorId = optionalControlId(body.actorId);
  return {
    ...(guildId === undefined ? {} : { guildId }),
    ...(actorId === undefined ? {} : { actorId }),
  };
}

function optionalControlId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid_voice_presence_request");
  const id = value.trim();
  if (id.length === 0 || id.length > 128) throw new Error("invalid_voice_presence_request");
  return id;
}
