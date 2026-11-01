import { upgradeWebSocket } from "@hono/node-server";
import { OPERATOR_VOICE_CALL_PATH, VOICE_CALL_AUDIO_FRAME_MAX_BYTES } from "@clankie/protocol";
import { characterNames } from "@clankie/settings";
import type { Hono } from "hono";
import type { BodyLeaseStore, LeaseRef } from "../body-leases.ts";
import type { ExtensionRouteHost } from "../ports/routes.ts";
import { VoiceCall, type VoiceCallLease } from "../voice-call.ts";
import { authenticateCaptain } from "./http-auth.ts";
import { logger } from "./log.ts";
import { composeVoiceCallBriefing, type VoiceBriefingRouteContext } from "./voice-briefing.ts";

const VOICE_LEASE_TTL_MS = 30_000;

/** His one voice (ADR 0215), held by the main conversation for the length of a call. */
function voiceCallLease(
  store: BodyLeaseStore,
  conversationId: string,
  roomName: (conversationId: string) => Promise<string | undefined>,
): VoiceCallLease {
  let held: LeaseRef | undefined;
  return {
    async acquire() {
      const result = store.acquire("voice", conversationId, VOICE_LEASE_TTL_MS, {
        owner: { conversationId },
        mode: "machine",
      });
      if (result.outcome === "acquired") {
        held = result.lease;
        return { outcome: "acquired" };
      }
      if (result.outcome === "busy") {
        // allow-swallowed-rejection -- the busy refusal stands; only the room's name is lost.
        const room = await roomName(result.lease.conversationId).catch(() => undefined);
        return { outcome: "busy", ...(room === undefined ? {} : { room }) };
      }
      return { outcome: "unavailable" };
    },
    renew() {
      return held !== undefined && store.renew(held, VOICE_LEASE_TTL_MS).outcome === "renewed";
    },
    release() {
      if (held === undefined) return;
      const released = store.release(held);
      if (released.outcome !== "released")
        logger.warn({ reason: released.reason }, "Device call voice lease release refused");
      held = undefined;
    },
  };
}

/**
 * A device voice call (VUH-2682). The relay opens this socket for an
 * authorized device with the captain bearer; the call itself is
 * `VoiceCall`, his Discord rooms' own session with the device as its media.
 */
export function registerVoiceCallRoute(app: Hono, host: ExtensionRouteHost) {
  // The Discord body's state is read when a call is served, as the core's own routes read it.
  const body = host.discordBody;
  const ctx: VoiceBriefingRouteContext = {
    app,
    settingsSource: host.settings,
    clock: host.clock,
    get dependencies() {
      return body.dependencies;
    },
    get captainPresence() {
      return body.captainPresence;
    },
    get discordPresenceSessions() {
      return body.discordPresenceSessions;
    },
    get discordStreamWatch() {
      return body.discordStreamWatch;
    },
    get embodiment() {
      return body.embodiment;
    },
    get recordEvent() {
      return body.recordEvent;
    },
    get idFactory() {
      return body.idFactory;
    },
  };
  ctx.app.get(OPERATOR_VOICE_CALL_PATH, async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_authentication_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "api")
      return context.json({ error: "operator_voice_authority_required" }, 403);
    const voice = ctx.dependencies.voiceCall;
    const leases = ctx.dependencies.bodyLeases?.store;
    if (voice === undefined || leases === undefined)
      return context.json({ error: "voice_call_unavailable" }, 503);
    const port = ctx.dependencies.captain;
    const mainId = port.mainConversationId();
    let decayWindowMs: number | undefined;
    let call: VoiceCall | undefined;
    return upgradeWebSocket(context, {
      onOpen(_event, ws) {
        call = new VoiceCall({
          peer: {
            get bufferedAmount() {
              const raw = ws.raw as { readonly bufferedAmount?: unknown } | undefined;
              return typeof raw?.bufferedAmount === "number" ? raw.bufferedAmount : 0;
            },
            sendEvent: (event) => ws.send(JSON.stringify(event)),
            sendAudio: (pcm) => ws.send(Uint8Array.from(pcm)),
            close: (code, reason) => ws.close(code, reason),
          },
          lease: voiceCallLease(leases, mainId, async (conversationId) => {
            const result = await port.serveOperatorConversation({
              op: "get",
              schemaVersion: 1,
              conversationId,
            });
            return result.op === "get" ? result.conversation?.title : undefined;
          }),
          realtime: async () => {
            const resolved = await voice.realtime();
            decayWindowMs = resolved?.decayWindowMs;
            return resolved?.ports;
          },
          floor: async () => {
            const persona = (await ctx.settingsSource.load()).persona;
            return {
              names: characterNames(persona),
              replyPolicy: persona.replyPolicy,
              chattiness: persona.chattiness,
              ...(decayWindowMs === undefined ? {} : { decayWindowMs }),
            };
          },
          briefing: () => composeVoiceCallBriefing(ctx),
          handoff: (input) => port.voiceCallHandoff(input),
          transcript: (line) => port.voiceCallTranscript(line),
          selfTool: async (call) => {
            const result = await port.voiceCallSelfTool(call);
            return result.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n")
              .slice(0, 2_000);
          },
          lookAtScreen: async () => {
            const live = ctx.embodiment.liveSession();
            const sight = ctx.dependencies.playSight?.still();
            if (live === undefined || sight === undefined) return { outcome: "not_playing" };
            if (sight.outcome === "not_playing") return { outcome: "pending" };
            if (sight.sessionId !== live.sessionId) return { outcome: "not_playing" };
            if (sight.outcome === "pending") return { outcome: "pending" };
            return { outcome: "still", pngBase64: sight.pngBase64, mimeType: "image/png" };
          },
          record: (evidence, callId) => {
            ctx.recordEvent(
              `voice-call.${evidence.type}`,
              `voice-call:${callId}`,
              ctx.clock().toISOString(),
              {
                ...evidence,
              },
            );
          },
          onEnded: (reason, failure) => logger.info({ reason, ...failure }, "Device voice call ended"),
          ...(voice.silentPeerMs === undefined ? {} : { silentPeerMs: voice.silentPeerMs }),
        });
        void call.start();
      },
      onMessage(event, ws) {
        if (call === undefined) return;
        if (typeof event.data === "string") {
          call.receiveText(event.data);
          return;
        }
        const data = event.data;
        const bytes =
          data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? data : undefined;
        if (bytes === undefined || bytes.byteLength > VOICE_CALL_AUDIO_FRAME_MAX_BYTES) {
          ws.close(1003, "unsupported_voice_frame");
          return;
        }
        const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        call.receiveAudio(view);
        view.fill(0);
      },
      onClose() {
        call?.closed();
      },
      onError() {
        call?.closed();
      },
    });
  });
}
