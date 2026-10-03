import type { BodyVoiceStays } from "./body-voice-stays.ts";
import type { BodyConversationIdentity, BodyLeaseRouter } from "./body-lease-router.ts";
import type { VoicePresenceControlInput } from "@clankie/discord-presence-core";
import {
  BodyVoiceTargetSchema,
  type BodyVoiceReconcileRequest,
  DiscordVoicePresenceResultSchema,
  type DiscordVoicePresenceResult,
} from "@clankie/protocol";
import { postToDiscordActiveBody } from "./discord-active-body.ts";

export function createDiscordVoicePresenceClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  leases?: { voice: BodyVoiceStays; router: BodyLeaseRouter },
): {
  join(
    input: VoicePresenceControlInput,
    identity?: BodyConversationIdentity,
  ): Promise<DiscordVoicePresenceResult>;
  leave(
    input: VoicePresenceControlInput,
    identity?: BodyConversationIdentity,
  ): Promise<DiscordVoicePresenceResult>;
} {
  const call = async (
    action: "join" | "leave",
    body: VoicePresenceControlInput,
    identity?: BodyConversationIdentity,
  ): Promise<DiscordVoicePresenceResult> => {
    if (leases === undefined) return postVoicePresence(action, body, env, fetchImpl);
    const refused = action === "join" ? ("join_refused" as const) : ("leave_refused" as const);
    if (identity === undefined)
      return {
        action: refused,
        reason: "failed",
        bodyLease: { outcome: "rejected", reason: "identity_required" },
      };
    if (action === "leave") {
      let result: DiscordVoicePresenceResult = { action: "leave_refused", reason: "failed" };
      const lease = await leases.router.recover(identity, "voice", async (guard) => {
        await guard();
        const stopped = await leases.voice.reconcile(
          (request) => reconcileDiscordVoice(request, env, fetchImpl),
          guard,
        );
        if (stopped) result = { action: "left" };
        return stopped;
      });
      return lease.outcome === "released" ? result : { action: refused, reason: "failed", bodyLease: lease };
    }
    try {
      const response = await postToDiscordActiveBody("/voice/resolve", body, env, fetchImpl);
      if (!response.ok) return { action: refused, reason: "failed" };
      const target = BodyVoiceTargetSchema.parse(await response.json());
      const issued = await leases.voice.ticket(identity, target);
      if (!("ticket" in issued)) return { action: refused, reason: "failed", bodyLease: issued };
      return postVoicePresence("join", { ...body, bodyLeaseTicket: issued.ticket }, env, fetchImpl);
    } catch {
      return { action: refused, reason: "failed" };
    }
  };
  return {
    join: (input, identity) => call("join", input, identity),
    leave: (input, identity) => call("leave", input, identity),
  };
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

/** Authenticated read-only body resolution; callers compare any intended target before ticket issuance. */
export async function resolveDiscordVoiceTarget(input: VoicePresenceControlInput) {
  const response = await postToDiscordActiveBody("/voice/resolve", input, process.env, fetch);
  return response.ok ? BodyVoiceTargetSchema.parse(await response.json()) : undefined;
}

export async function reconcileDiscordVoice(
  request: BodyVoiceReconcileRequest,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await postToDiscordActiveBody("/voice/reconcile", request, env, fetchImpl);
  return response.ok ? response.json() : undefined;
}
