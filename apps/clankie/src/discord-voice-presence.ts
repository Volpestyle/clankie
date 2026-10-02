import type { VoicePresenceControlInput } from "@clankie/discord-presence-core";
import { DiscordVoicePresenceResultSchema, type DiscordVoicePresenceResult } from "@clankie/protocol";
import { postToDiscordActiveBody } from "./discord-active-body.ts";

export function createDiscordVoicePresenceClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): {
  join(input: VoicePresenceControlInput): Promise<DiscordVoicePresenceResult>;
  leave(input: VoicePresenceControlInput): Promise<DiscordVoicePresenceResult>;
} {
  const call = (action: "join" | "leave", body: VoicePresenceControlInput) =>
    postVoicePresence(action, body, env, fetchImpl);
  return { join: (input) => call("join", input), leave: (input) => call("leave", input) };
}

async function postVoicePresence(
  action: "join" | "leave",
  body: VoicePresenceControlInput,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<DiscordVoicePresenceResult> {
  const refused = action === "join" ? ("join_refused" as const) : ("leave_refused" as const);
  try {
    const response = await postToDiscordActiveBody(`/voice/${action}`, body, env, fetchImpl);
    if (!response.ok) return { action: refused, reason: "failed" };
    const parsed = DiscordVoicePresenceResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { action: refused, reason: "failed" };
  } catch {
    return { action: refused, reason: "failed" };
  }
}
