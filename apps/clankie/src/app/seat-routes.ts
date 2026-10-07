import { DEFAULT_PROJECT_ID } from "@clankie/protocol/projects";
import {
  FLEET_SEAT_TOOL_CATALOG_PATH,
  FLEET_TOOL_CATALOG_HEALTH_PATH,
  FleetSeatToolCatalogSchema,
} from "@clankie/protocol/tool-catalog";
import { SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import {
  CaptainSessionLaneV2Schema,
  FLEET_PEER_MESSAGES_PATH,
  FLEET_PEER_SEATS_PATH,
  FLEET_SEAT_EVENTS_PATH,
  FLEET_SEAT_HOOK_PATH,
  FLEET_SEAT_MESSAGES_PATH,
  FleetPeerMessageSchema,
  FleetSeatHookSchema,
  FleetSeatMessageDeliverySchema,
  FleetSeatMessageReceiptSchema,
  FleetSeatMessageSchema,
  WorkerReportBridgeStatusSchema,
  OPERATOR_SEAT_EVENTS_PATH,
  OPERATOR_SEAT_EVENT_WAIT_MS_MAX,
  OperatorConversationServiceRequestSchema,
  OperatorSeatReplySchema,
  type CaptainSessionLaneV2,
  type OperatorSeatEventsPage,
} from "@clankie/protocol";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { PeerSeatAuthority } from "../captain/peer-seat-messages.ts";
import { CAPTAIN_PROMPT_SECTIONS, type CaptainPromptSection } from "../captain/port.ts";
import { INBOUND_REQUEST_DEADLINE_MS } from "../captain/inbound-seat-receipts.ts";
import { createLaneMcpEndpoint } from "../lane-mcp.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { readJson } from "./http-auth.ts";
import { type ClankieAppDependencies } from "./types.ts";
import { peerSeatAuthority as resolvePeerSeatAuthority } from "./peer-seat-authority.ts";
import { RemoteObservationError } from "../remote-fleet-relay.ts";
import { SeatLinkInterruptedError } from "../captain/seat-outbox.ts";

/**
 * A seat bridge talking to a service that is shutting down gets a 503 and a
 * closed connection, so it backs off and reconnects to whichever process owns
 * the port next. An empty 200 kept it pinned to the old process for 50 minutes
 * after an update on 2026-10-07, while the replacement routed every wake away
 * from the unbound seat.
 */
async function refuseWhileClosing(context: Context, handle: () => Promise<Response>): Promise<Response> {
  try {
    return await handle();
  } catch (error) {
    if (!(error instanceof SeatLinkInterruptedError)) throw error;
    context.header("connection", "close");
    return context.json({ error: "service_shutting_down" }, 503);
  }
}
/**
 * A headless read of a lane's prompt (VUH-1086). The lane defaults to the one
 * the bearer speaks for; sections default to what the pi session starts with.
 */
const CaptainLanePromptQuerySchema = z
  .object({
    lane: CaptainSessionLaneV2Schema.optional(),
    conversationId: z.string().trim().min(1).max(256).optional(),
    harness: z.enum(["claude"]).optional(),
    sections: z
      .string()
      .transform((raw) =>
        raw
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      )
      .pipe(z.array(z.enum(CAPTAIN_PROMPT_SECTIONS)).min(1).max(CAPTAIN_PROMPT_SECTIONS.length))
      .optional(),
  })
  .strict();
export interface RegisterSeatRoutesContext {
  readonly dependencies: ClankieAppDependencies;
  readonly app: Hono;
  readonly authenticateLane: (
    context: Context,
  ) => Promise<{ lane: CaptainSessionLaneV2 } | { denial: Response }>;
}

export function registerSeatRoutes(ctx: RegisterSeatRoutesContext) {
  const seatBinding = (
    context: Context,
    lane: string,
  ): { conversationId?: string; cwd?: string } | { denial: Response } => {
    const raw = context.req.query("conversationId");
    if (raw !== undefined && !z.string().trim().min(1).max(256).safeParse(raw).success)
      return { denial: context.json({ error: "invalid_conversation" }, 400) };
    if (lane !== "operator")
      return raw === undefined ? {} : { denial: context.json({ error: "lane_forbidden" }, 403) };
    const binding = ctx.dependencies.captain.seatContext(raw?.trim());
    return binding ?? { denial: context.json({ error: "unknown_captain_conversation" }, 404) };
  };

  ctx.app.get("/v1/captain/seat-context", async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const binding = seatBinding(context, auth.lane);
    if ("denial" in binding) return binding.denial;
    // A launcher without --conversation takes the global chat only while no live seat holds it.
    const occupied = ctx.dependencies.captain.operatorSeatReady?.(binding.conversationId) === true;
    return context.json({ ...binding, occupied });
  });

  // Native seats use the same registry as the app, with a fresh workspace chat
  // per launch. The operator bearer can create only this kind of seat context.
  ctx.app.post("/v1/captain/seat-context", bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const parsed = OperatorConversationServiceRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success || parsed.data.op !== "create" || parsed.data.scope.kind !== "workspace")
      return context.json({ error: "invalid_seat_conversation" }, 400);
    const result = await ctx.dependencies.captain.serveOperatorConversation(parsed.data);
    if (result.op !== "create") return context.json({ error: "seat_conversation_unavailable" }, 503);
    const binding = ctx.dependencies.captain.seatContext(result.conversation.conversationId);
    return binding === undefined
      ? context.json({ error: "seat_conversation_unavailable" }, 503)
      : context.json(binding, 201);
  });

  ctx.app.post("/v1/seat/transcript", bodyLimit({ maxSize: 1024 * 1024 }), async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const binding = seatBinding(context, auth.lane);
    if ("denial" in binding) return binding.denial;
    const parsed = SeatTranscriptUploadSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_seat_transcript" }, 400);
    if (!ctx.dependencies.captain.syncSeatTranscript(binding.conversationId!, parsed.data))
      return context.json({ error: "seat_session_conflict" }, 409);
    return context.json({ ok: true });
  });

  // The lane's prompt and memory card, readable outside a pi session so a seat
  // in another harness starts from the same words (VUH-1086). A bearer may read
  // only its own lane: the operator card carries operator-private notes.
  ctx.app.get("/v1/captain/prompt", async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    const query = CaptainLanePromptQuerySchema.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "invalid_request" }, 400);
    const lane = query.data.lane ?? auth.lane;
    if (lane !== auth.lane) return context.json({ error: "lane_forbidden" }, 403);
    const binding = seatBinding(context, lane);
    if ("denial" in binding) return binding.denial;
    const sections: readonly CaptainPromptSection[] | undefined = query.data.sections;
    return context.text(
      await ctx.dependencies.captain.lanePrompt({
        lane,
        ...(sections === undefined ? {} : { sections }),
        ...(query.data.conversationId === undefined ? {} : { conversationId: binding.conversationId! }),
        ...(query.data.harness === undefined ? {} : { harness: query.data.harness }),
      }),
    );
  });

  // The seat's outbox (ADR 0152). Only the operator's own bearer polls it —
  // the seat is the owner's — and only the service's own turns fill it, so no
  // other principal can put text in front of him through this door.
  ctx.app.get(OPERATOR_SEAT_EVENTS_PATH, (context) =>
    refuseWhileClosing(context, async () => {
      const auth = await ctx.authenticateLane(context);
      if ("denial" in auth) return auth.denial;
      if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
      const wait = Number(context.req.query("wait") ?? 0);
      const waitMs = Number.isFinite(wait)
        ? Math.min(Math.max(0, Math.trunc(wait)), OPERATOR_SEAT_EVENT_WAIT_MS_MAX)
        : 0;
      const binding = seatBinding(context, auth.lane);
      if ("denial" in binding) return binding.denial;
      const events = await ctx.dependencies.captain.pollSeatEvents(
        waitMs,
        context.req.raw.signal,
        binding.conversationId,
      );
      const page: OperatorSeatEventsPage = { schemaVersion: 1, events: [...events] };
      return context.json(page);
    }),
  );

  ctx.app.post(`${OPERATOR_SEAT_EVENTS_PATH}/:id/ack`, (context) =>
    refuseWhileClosing(context, async () => {
      const auth = await ctx.authenticateLane(context);
      if ("denial" in auth) return auth.denial;
      if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
      const binding = seatBinding(context, auth.lane);
      if ("denial" in binding) return binding.denial;
      const acknowledged = await ctx.dependencies.captain.acknowledgeSeatEvent(
        context.req.param("id"),
        binding.conversationId,
      );
      return acknowledged
        ? context.json({ schemaVersion: 1, acknowledged: true, deliveryStage: "delivered" })
        : context.json({ error: "unknown_event" }, 404);
    }),
  );

  ctx.app.post(`${OPERATOR_SEAT_EVENTS_PATH}/:id/reply`, async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const parsed = OperatorSeatReplySchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const binding = seatBinding(context, auth.lane);
    if ("denial" in binding) return binding.denial;
    const replied = await ctx.dependencies.captain.replySeatEvent(
      context.req.param("id"),
      parsed.data.text,
      binding.conversationId,
    );
    return replied
      ? context.json({
          schemaVersion: 1 as const,
          replied: true as const,
          deliveryStage: "responded" as const,
        })
      : context.json({ error: "unknown_event" }, 404);
  });

  /**
   * The pane a fleet seat route names. The operator lane names any pane; a
   * remote linked seat must prove its native process on that exact relay stream.
   * A machine link token cannot name or drain another pane's mailbox.
   */
  const fleetSeatPane = async (
    context: Context,
  ): Promise<{ readonly paneId: string } | { readonly denial: Response }> => {
    const raw = context.req.param("paneId") ?? "";
    const local = ctx.dependencies.localFleet?.identity(context.req.raw);
    if (local)
      return local.pane === raw && (await local.validate())
        ? { paneId: raw }
        : { denial: context.json({ error: "local_pane_required" }, 403) };
    const header = context.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    const fleet = token === undefined ? undefined : ctx.dependencies.fleetLinks?.authenticate(token);
    const remote = ctx.dependencies.fleetLinks?.identity?.(context.req.raw);
    if (remote) {
      try {
        const proof =
          remote.pane === raw && (await remote.validate()) ? await remote.projectProof?.() : undefined;
        return proof && proof.pane === raw && proof.fleet !== "default" && (await remote.validate())
          ? { paneId: `${proof.fleet}/${raw}` }
          : { denial: context.json({ error: "remote_pane_required" }, 403) };
      } catch (error) {
        if (error instanceof RemoteObservationError)
          return { denial: context.json({ error: error.code }, 503) };
        throw error;
      }
    }
    if (fleet !== undefined)
      return { denial: context.json({ error: "remote_process_membership_required" }, 403) };
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return { denial: auth.denial };
    if (auth.lane !== "operator") return { denial: context.json({ error: "lane_forbidden" }, 403) };
    return { paneId: raw };
  };

  /** Peer sender attribution requires a native process proof, never an operator or fleet bearer. */
  const peerSeatAuthority = (context: Context): Promise<PeerSeatAuthority | undefined> =>
    resolvePeerSeatAuthority(
      ctx.dependencies.localFleet?.identity(context.req.raw) ??
        ctx.dependencies.fleetLinks?.identity?.(context.req.raw),
      context.req.param("paneId"),
    );
  ctx.app.get(FLEET_PEER_SEATS_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await peerSeatAuthority(context);
    if (!authority) return context.json({ error: "native_peer_sender_required" }, 403);
    if (ctx.dependencies.settings && (await ctx.dependencies.settings.load()).fleet.peerMessages === "off")
      return context.json({ error: "peer_messages_disabled" }, 403);
    const seats = await ctx.dependencies.captain.listFleetPeerSeats(authority);
    return seats ? context.json(seats) : context.json({ error: "peer_messaging_unavailable" }, 403);
  });
  ctx.app.post(FLEET_PEER_MESSAGES_PATH, bodyLimit({ maxSize: 128 * 1024 }), async (context) => {
    const authority = await peerSeatAuthority(context);
    if (!authority) return context.json({ error: "native_peer_sender_required" }, 403);
    const input = FleetPeerMessageSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_peer_message" }, 400);
    return context.json(await ctx.dependencies.captain.sendFleetPeerMessage(authority, input.data));
  });
  ctx.app.get(`${FLEET_PEER_MESSAGES_PATH}/:id`, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await peerSeatAuthority(context);
    if (!authority) return context.json({ error: "native_peer_sender_required" }, 403);
    const delivery = FleetSeatMessageDeliverySchema.safeParse({
      id: context.req.param("id"),
      binding: context.req.query("binding"),
    });
    const fingerprint = context.req.query("fingerprint") ?? "";
    if (!delivery.success || !/^[a-f0-9]{64}$/u.test(fingerprint))
      return context.json({ error: "invalid_peer_receipt" }, 400);
    const receipt = await ctx.dependencies.captain.reconcileFleetPeerMessage(
      authority,
      delivery.data,
      fingerprint,
    );
    return receipt
      ? context.json(receipt)
      : context.json({ error: "unknown_peer_receipt", deliveryStage: "uncertain" }, 404);
  });

  // A fleet seat's mailbox (ADR 0161). Same door as the head outbox — operator
  // lane only, or a linked fleet for its own panes — keyed by the pane the
  // bridge sits in. 404 is the pane before herdr has classified the harness;
  // the bridge retries.
  ctx.app.get(FLEET_SEAT_EVENTS_PATH, (context) =>
    refuseWhileClosing(context, async () => {
      const pane = await fleetSeatPane(context);
      if ("denial" in pane) return pane.denial;
      const wait = Number(context.req.query("wait") ?? 0);
      const waitMs = Number.isFinite(wait)
        ? Math.min(Math.max(0, Math.trunc(wait)), OPERATOR_SEAT_EVENT_WAIT_MS_MAX)
        : 0;
      const events = await ctx.dependencies.captain.pollFleetSeatEvents(
        pane.paneId,
        waitMs,
        context.req.raw.signal,
      );
      if (events === undefined) return context.json({ error: "unknown_seat" }, 404);
      const page: OperatorSeatEventsPage = { schemaVersion: 1, events: [...events] };
      return context.json(page);
    }),
  );

  ctx.app.post(`${FLEET_SEAT_EVENTS_PATH}/:id/ack`, (context) =>
    refuseWhileClosing(context, async () => {
      const pane = await fleetSeatPane(context);
      if ("denial" in pane) return pane.denial;
      const acknowledged = await ctx.dependencies.captain.acknowledgeFleetSeatEvent(
        pane.paneId,
        context.req.param("id"),
      );
      return acknowledged
        ? context.json({ schemaVersion: 1, acknowledged: true, deliveryStage: "delivered" })
        : context.json({ error: "unknown_event" }, 404);
    }),
  );

  // An agent in a fleet pane writing to Clankie (ADR 0213 phase 2). It reaches
  // him as untrusted agent output and grants the sender nothing.
  ctx.app.post(`${FLEET_SEAT_MESSAGES_PATH}/health`, bodyLimit({ maxSize: 4096 }), async (context) => {
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const parsed = WorkerReportBridgeStatusSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const binding = await ctx.dependencies.captain.fleetSeatMessageBinding(pane.paneId);
    if (!binding) return context.json({ error: "native_session_required" }, 403);
    const identity =
      ctx.dependencies.localFleet?.identity(context.req.raw) ??
      ctx.dependencies.fleetLinks?.identity?.(context.req.raw);
    if (identity && !(await identity.validate()))
      return context.json({ error: "native_session_required" }, 403);
    if ((await ctx.dependencies.captain.fleetSeatMessageBinding(pane.paneId)) !== binding)
      return context.json({ error: "native_session_required" }, 403);
    if (identity && !(await identity.validate()))
      return context.json({ error: "native_session_required" }, 403);
    if (!ctx.dependencies.workerMcp) return context.json({ error: "worker_health_unavailable" }, 503);
    const qualified = splitFleetQualified(pane.paneId);
    ctx.dependencies.workerMcp.reportBridgeObserved(
      qualified?.fleet ?? "default",
      qualified?.id ?? pane.paneId,
      parsed.data,
    );
    return context.json({ recorded: true }, 202);
  });
  ctx.app.get(FLEET_SEAT_MESSAGES_PATH, async (context) => {
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const binding = await ctx.dependencies.captain.fleetSeatMessageBinding(pane.paneId);
    return binding
      ? context.json({ schemaVersion: 1, binding })
      : context.json({ error: "unknown_native_session", deliveryStage: "unavailable" }, 404);
  });
  ctx.app.get(`${FLEET_SEAT_MESSAGES_PATH}/:id`, async (context) => {
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const delivery = FleetSeatMessageDeliverySchema.safeParse({
      id: context.req.param("id"),
      binding: context.req.query("binding"),
    });
    const fingerprint = context.req.query("fingerprint") ?? "";
    if (!delivery.success || !/^[a-f0-9]{64}$/u.test(fingerprint))
      return context.json({ error: "invalid_request" }, 400);
    return context.json(
      await ctx.dependencies.captain.reconcileFleetSeatMessage(pane.paneId, delivery.data, fingerprint),
    );
  });

  const limitInboundBody = bodyLimit({ maxSize: 128 * 1024 });
  ctx.app.post(FLEET_SEAT_MESSAGES_PATH, async (context) => {
    const request = {
      deadlineAt: Date.now() + INBOUND_REQUEST_DEADLINE_MS,
      signal: context.req.raw.signal,
    };
    // Include body/authentication waits in the original budget, retaining the
    // transport signal even when the body limiter reconstructs a chunked request.
    await limitInboundBody(context, async () => {});
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const parsed = FleetSeatMessageSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_request", deliveryStage: "rejected" }, 400);
    if (!parsed.data.delivery)
      return context.json({ error: "delivery_id_required", received: false, deliveryStage: "rejected" }, 400);
    const received = await ctx.dependencies.captain.receiveFleetSeatMessage(
      pane.paneId,
      parsed.data.text,
      parsed.data.delivery,
      request,
    );
    if (typeof received !== "boolean") return context.json(FleetSeatMessageReceiptSchema.parse(received));
    return received
      ? context.json({ schemaVersion: 1 as const, received: true as const, deliveryStage: "stored" as const })
      : context.json({ error: "unknown_seat", deliveryStage: "unavailable" }, 404);
  });

  ctx.app.get(FLEET_TOOL_CATALOG_HEALTH_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    return context.json(await ctx.dependencies.captain.toolCatalogHealth());
  });
  ctx.app.post(FLEET_SEAT_TOOL_CATALOG_PATH, bodyLimit({ maxSize: 1024 * 1024 }), async (context) => {
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const parsed = FleetSeatToolCatalogSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const identity =
      ctx.dependencies.localFleet?.identity(context.req.raw) ??
      ctx.dependencies.fleetLinks?.identity?.(context.req.raw);
    try {
      const proof = identity && (await identity.validate()) ? await identity.projectProof?.() : undefined;
      if (identity && (!proof || !(await identity.validate())))
        return context.json({ error: "native_session_required" }, 403);
      const workerTools =
        (await ctx.dependencies.workerMcp?.expectedProjectToolNames(DEFAULT_PROJECT_ID)) ?? [];
      const health = await ctx.dependencies.captain.recordSeatToolCatalog(
        pane.paneId,
        parsed.data,
        workerTools,
        proof,
      );
      return health ? context.json(health) : context.json({ error: "native_session_required" }, 403);
    } catch (error) {
      if (error instanceof RemoteObservationError) return context.json({ error: error.code }, 503);
      throw error;
    }
  });

  // A hired seat's worker plugin reports each settled turn (VUH-1458), from
  // inside the pane it names. Same door as its mailbox.
  ctx.app.post(FLEET_SEAT_HOOK_PATH, bodyLimit({ maxSize: 128 * 1024 }), async (context) => {
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const parsed = FleetSeatHookSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const identity =
      ctx.dependencies.localFleet?.identity(context.req.raw) ??
      ctx.dependencies.fleetLinks?.identity?.(context.req.raw);
    const proof = identity && (await identity.validate()) ? await identity.projectProof?.() : undefined;
    const recorded = await ctx.dependencies.captain.recordSeatHook(
      pane.paneId,
      parsed.data,
      proof,
      context.req.raw.signal,
    );
    return recorded
      ? context.json({
          schemaVersion: 1 as const,
          recorded: true as const,
          ...(typeof recorded === "object" && "hookOutput" in recorded
            ? { hookOutput: recorded.hookOutput }
            : {}),
          ...(typeof recorded === "object" && "additionalContext" in recorded
            ? {
                additionalContext: recorded.additionalContext,
                messageIds: recorded.messageIds,
                deliveryStage: "uncertain" as const,
              }
            : {}),
        })
      : context.json({ error: "unknown_seat" }, 404);
  });

  ctx.app.get("/v1/captain/memory-card", async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    const lane = CaptainSessionLaneV2Schema.safeParse(context.req.query("lane") ?? auth.lane);
    if (!lane.success) return context.json({ error: "invalid_request" }, 400);
    if (lane.data !== auth.lane) return context.json({ error: "lane_forbidden" }, 403);
    return context.text(await ctx.dependencies.captain.laneMemoryCard(lane.data));
  });

  // The same lane's tools, over streamable-HTTP MCP, for a seat in a harness
  // that speaks it (VUH-1085). The bearer selects the lane; the captain's tool
  // registry is still the only place a tool is defined.
  const laneMcp = createLaneMcpEndpoint({
    captain: ctx.dependencies.captain,
    ...(ctx.dependencies.seatCallReceiptPath === undefined
      ? {}
      : { receiptPath: ctx.dependencies.seatCallReceiptPath }),
  });
  ctx.app.all("/v1/mcp", async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    const binding = seatBinding(context, auth.lane);
    if ("denial" in binding) return binding.denial;
    return laneMcp.handle(context.req.raw, auth.lane, binding.conversationId);
  });
  return { laneMcp };
}
