import { DEFAULT_PROJECT_ID } from "@clankie/protocol/projects";
import {
  FLEET_SEAT_TOOL_CATALOG_PATH,
  FLEET_TOOL_CATALOG_HEALTH_PATH,
  FleetSeatToolCatalogSchema,
} from "@clankie/protocol/tool-catalog";
import { SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import {
  CaptainSessionLaneV2Schema,
  FLEET_EVIDENCE_UPLOADS_PATH,
  FLEET_PEER_MESSAGES_PATH,
  FLEET_PEER_SEATS_PATH,
  FLEET_SEAT_EVENTS_PATH,
  FLEET_SEAT_HOOK_PATH,
  FLEET_SEAT_MESSAGES_PATH,
  FleetPeerMessageSchema,
  FleetSeatHookSchema,
  ClaudeChannelPermissionRequestSchema,
  FleetSeatMessageDeliverySchema,
  FleetSeatMessageReceiptSchema,
  FleetSeatMessageStatusSchema,
  FleetSeatMessageSchema,
  WorkerReportBridgeStatusSchema,
  OPERATOR_SEAT_BINDINGS_PATH,
  OPERATOR_SEAT_BRIDGE_CLAIM_HEADER,
  OperatorSeatBindingRequestSchema,
  OPERATOR_SEAT_EVENTS_PATH,
  OPERATOR_SEAT_CAPABILITIES_HEADER,
  OperatorSeatCapabilitiesSchema,
  OPERATOR_SEAT_EVENT_WAIT_MS_MAX,
  OperatorConversationServiceRequestSchema,
  OperatorSeatReplySchema,
  type CaptainSessionLaneV2,
  type OperatorSeatEventsPage,
} from "@clankie/protocol";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { PeerSeatAuthority } from "../captain/peer-seat-messages.ts";
import { CAPTAIN_PROMPT_SECTIONS, type CaptainPromptSection } from "../captain/port.ts";
import { INBOUND_REQUEST_DEADLINE_MS } from "../captain/inbound-seat-receipts.ts";
import { createLaneMcpEndpoint } from "../lane-mcp.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { FLEET_CATALOG_REVISION_HEADER } from "../worker-mcp.ts";
import { readJson } from "./http-auth.ts";
import { type ClankieAppDependencies } from "./types.ts";
import { peerSeatAuthority as resolvePeerSeatAuthority } from "./peer-seat-authority.ts";
import { RemoteObservationError } from "../remote-fleet-relay.ts";
import { fleetAdmissionUnavailableResponse } from "../local-fleet-admission.ts";
import { SeatLinkInterruptedError } from "../captain/seat-outbox.ts";
import { seatBindingRecovery } from "../operator-seat-bindings.ts";
import { SeatCallReceipts } from "../seat-call-receipts.ts";
import { OPERATOR_SEAT_MIGRATIONS_PATH, OperatorSeatMigrationRequestSchema } from "@clankie/protocol";
import {
  FLEET_REVIEW_CANDIDATES_PATH,
  FLEET_REVIEW_VERDICTS_PATH,
  REVIEW_PATCH_MAX_BYTES,
  ReviewSubmissionSchema,
  ReviewVerdictInputSchema,
} from "@clankie/protocol/reviews";
import { reviewRefusalStatus } from "../review-routes.ts";
import { EvidenceRefusal } from "../evidence-store.ts";

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
  ctx.app.post(OPERATOR_SEAT_MIGRATIONS_PATH, bodyLimit({ maxSize: 8 * 1024 }), async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const parsed = OperatorSeatMigrationRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_seat_migration" }, 400);
    const migrations = ctx.dependencies.operatorSeatMigrations;
    if (!migrations || !ctx.dependencies.seatCallReceiptPath)
      return context.json({ error: "seat_migration_unavailable" }, 503);
    const input = parsed.data;
    try {
      if (input.action === "prepare") {
        const inventory = await ctx.dependencies.operatorSeatInventory?.();
        const seats = inventory?.seats.filter((seat) => seat.conversationId === input.conversationId);
        const recovery = await ctx.dependencies.captain.operatorSeatRecovery?.(
          input.conversationId,
          seats?.[0]?.sessionId,
        );
        if (
          !inventory?.complete ||
          seats?.length !== 1 ||
          !recovery?.sessionId ||
          !recovery.cwd ||
          !recovery.profile
        )
          throw Error("Exact native session, profile and unique launcher are required; migration held");
        if (ctx.dependencies.captain.operatorSeatMigrationIdle?.(input.conversationId) !== true)
          throw Error("Native turn or original delivery is unsettled; reconcile it before migration");
        migrations.prepare({
          id: input.id,
          conversationId: input.conversationId,
          sessionId: recovery.sessionId,
          cwd: recovery.cwd,
          profile: recovery.profile,
          processes: seats[0]!.processes,
        });
      }
      let migration = migrations.get(input.id);
      const pendingReceiptIds = new SeatCallReceipts(ctx.dependencies.seatCallReceiptPath).pending(
        migration.conversationId,
      );
      if (input.action === "claim") {
        if (pendingReceiptIds.length)
          throw Error("Original call receipts are unresolved; inspect their exact IDs, never replay");
        migration = await migrations.claim(input.id, {
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          cwd: input.cwd,
          profile: input.profile,
        });
      }
      if (input.action === "complete") {
        const inventory = await ctx.dependencies.operatorSeatInventory?.();
        const seats = inventory?.seats.filter((seat) => seat.conversationId === migration.conversationId);
        const recovery = await ctx.dependencies.captain.operatorSeatRecovery?.(
          migration.conversationId,
          seats?.[0]?.sessionId,
        );
        if (
          pendingReceiptIds.length ||
          !inventory?.complete ||
          seats?.length !== 1 ||
          seats[0]?.bound !== true ||
          recovery?.sessionId !== migration.sessionId ||
          recovery.cwd !== migration.cwd ||
          recovery.profile !== migration.profile ||
          ctx.dependencies.captain.operatorSeatReady?.(migration.conversationId) !== true
        )
          throw Error("Exact resumed session binding/readiness is unconfirmed; migration remains held");
        migration = migrations.complete(input.id);
      }
      return context.json({ migration, pendingReceiptIds });
    } catch (error) {
      return context.json(
        {
          error: "seat_migration_held",
          detail: error instanceof Error ? error.message : "Migration evidence unavailable",
        },
        409,
      );
    }
  });
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

  /**
   * The operator lane acts as the lead only for the process its launcher
   * registered (VUH-2816). The conversation is read raw: the service-wide
   * default of `global-default` never stands in for a caller that named none.
   */
  const refuseUnboundOperator = async (context: Context, lane: string): Promise<Response | undefined> => {
    if (lane !== "operator") return undefined;
    const socket = (context.env as HttpBindings | undefined)?.incoming?.socket;
    const bindings = ctx.dependencies.operatorSeatBindings;
    const admitted = await (bindings?.admit(socket, {
      conversationId: context.req.query("conversationId")?.trim(),
      claim: context.req.header(OPERATOR_SEAT_BRIDGE_CLAIM_HEADER),
    }) ?? { ok: false as const, error: "seat_binding_required" as const, status: 403 as const });
    return admitted.ok
      ? undefined
      : context.json(
          {
            error: admitted.error,
            detail: seatBindingRecovery(admitted.error),
            recovery: seatBindingRecovery(admitted.error),
          },
          admitted.status,
        );
  };

  // The launcher that spawned a harness registers it. The caller's process, proven
  // from its socket, becomes the conversation's controller; it names only the harness.
  ctx.app.get(OPERATOR_SEAT_BINDINGS_PATH, async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const bindings = ctx.dependencies.operatorSeatBindings;
    const inventory = await ctx.dependencies.operatorSeatInventory?.();
    if (inventory) {
      inventory.migrations = ctx.dependencies.operatorSeatMigrations?.pending() ?? [];
      if (inventory.migrations.length) inventory.ready = false;
    }
    if (inventory)
      for (const seat of inventory.seats) {
        const migration = seat.conversationId
          ? ctx.dependencies.operatorSeatMigrations?.forConversation(seat.conversationId)
          : undefined;
        if (migration) {
          seat.migration = { id: migration.id, state: migration.state };
          inventory.ready = false;
        }
        if (
          !seat.bound &&
          seat.state !== "bridge-pending" &&
          seat.conversationId &&
          ctx.dependencies.captain.operatorSeatRecovery
        ) {
          try {
            const recovery = await ctx.dependencies.captain.operatorSeatRecovery(
              seat.conversationId,
              seat.sessionId,
            );
            seat.recovery = recovery.recovery;
            if (recovery.sessionId && recovery.profile) {
              const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
              seat.recovery = migration
                ? `Migration ${migration.id} is ${migration.state}. Inspect original receipts with clankie seat migrate status ${migration.id}. After confirmed old-process exit: env CLAUDE_CONFIG_DIR=${quote(recovery.profile)} clankie claude --resume ${recovery.sessionId} --conversation ${quote(seat.conversationId)} --migration ${migration.id}. Never repeat a claimed launch. Once bound and ready: clankie seat migrate complete ${migration.id}.`
                : `Preserve and reconcile original receipts; never replay. First: clankie seat migrate prepare --conversation ${quote(seat.conversationId)}. Keep the returned migration ID. Exit only this exact native session, then follow clankie doctor for its exact resume command. ${recovery.recovery}`;
            }
          } catch {
            seat.recovery =
              "Migration held: native session/profile recovery is unavailable. Preserve original receipts and inspect this launcher; do not start a substitute session.";
          }
        }
      }
    return context.json(
      bindings
        ? {
            ...bindings.status(),
            inventory: inventory ?? {
              complete: false,
              ready: false,
              seats: [],
              error: "operator_seat_inventory_unavailable",
            },
          }
        : {
            available: false,
            error: "seat_binding_unavailable",
            recovery: seatBindingRecovery("seat_binding_unavailable"),
            bindings: [],
          },
    );
  });
  ctx.app.put(OPERATOR_SEAT_BINDINGS_PATH, bodyLimit({ maxSize: 4 * 1024 }), async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const parsed = OperatorSeatBindingRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_seat_binding" }, 400);
    const socket = (context.env as HttpBindings | undefined)?.incoming?.socket;
    if (socket === undefined)
      return context.json(
        { error: "seat_process_unproven", recovery: seatBindingRecovery("seat_process_unproven") },
        403,
      );
    const bindings = ctx.dependencies.operatorSeatBindings;
    if (bindings === undefined)
      return context.json(
        { error: "seat_binding_unavailable", recovery: seatBindingRecovery("seat_binding_unavailable") },
        503,
      );
    const result = await bindings.register(socket, parsed.data);
    return result.ok
      ? context.json({ ok: true })
      : context.json({ error: result.error, recovery: seatBindingRecovery(result.error) }, result.status);
  });
  ctx.app.delete(OPERATOR_SEAT_BINDINGS_PATH, async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const conversationId = context.req.query("conversationId")?.trim();
    const socket = (context.env as HttpBindings | undefined)?.incoming?.socket;
    if (!conversationId)
      return context.json(
        {
          error: "seat_binding_conversation_required",
          recovery: seatBindingRecovery("seat_binding_conversation_required"),
        },
        403,
      );
    if (socket === undefined)
      return context.json(
        { error: "seat_process_unproven", recovery: seatBindingRecovery("seat_process_unproven") },
        403,
      );
    const bindings = ctx.dependencies.operatorSeatBindings;
    if (bindings === undefined)
      return context.json(
        { error: "seat_binding_unavailable", recovery: seatBindingRecovery("seat_binding_unavailable") },
        503,
      );
    const result = await bindings.deregister(socket, conversationId);
    return result.ok
      ? context.json({ ok: true })
      : context.json({ error: result.error, recovery: seatBindingRecovery(result.error) }, result.status);
  });

  ctx.app.get("/v1/captain/seat-context", async (context) => {
    const auth = await ctx.authenticateLane(context);
    if ("denial" in auth) return auth.denial;
    if (auth.lane !== "operator") return context.json({ error: "lane_forbidden" }, 403);
    const binding = seatBinding(context, auth.lane);
    if ("denial" in binding) return binding.denial;
    // A launcher without --conversation takes the global chat only while no live seat holds it.
    const occupied = ctx.dependencies.captain.operatorSeatReady?.(binding.conversationId) === true;
    // An explicit resume asks which conversation that native session belongs to.
    const sessionId = z.uuid().safeParse(context.req.query("sessionId"));
    const session =
      sessionId.success && binding.conversationId !== undefined
        ? ctx.dependencies.captain.seatSessionState?.(binding.conversationId, sessionId.data)
        : undefined;
    return context.json({ ...binding, occupied, ...(session === undefined ? {} : { session }) });
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
      const unbound = await refuseUnboundOperator(context, auth.lane);
      if (unbound !== undefined) return unbound;
      const wait = Number(context.req.query("wait") ?? 0);
      const waitMs = Number.isFinite(wait)
        ? Math.min(Math.max(0, Math.trunc(wait)), OPERATOR_SEAT_EVENT_WAIT_MS_MAX)
        : 0;
      const binding = seatBinding(context, auth.lane);
      if ("denial" in binding) return binding.denial;
      const advertised = context.req.header(OPERATOR_SEAT_CAPABILITIES_HEADER);
      const capabilities =
        advertised === undefined
          ? undefined
          : OperatorSeatCapabilitiesSchema.safeParse(
              advertised.length > 2048
                ? undefined
                : (() => {
                    try {
                      return JSON.parse(advertised);
                    } catch {
                      return undefined;
                    }
                  })(),
            );
      if (capabilities && !capabilities.success)
        return context.json(
          { error: "invalid_seat_capabilities", detail: "Clankie's seat needs a reconnect: /mcp" },
          400,
        );
      const events = await ctx.dependencies.captain.pollSeatEvents(
        waitMs,
        context.req.raw.signal,
        binding.conversationId,
        capabilities?.data,
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
      const unbound = await refuseUnboundOperator(context, auth.lane);
      if (unbound !== undefined) return unbound;
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
    const unbound = await refuseUnboundOperator(context, auth.lane);
    if (unbound !== undefined) return unbound;
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
        // A slow or lost remote proof is refused before any route effect. Use
        // the retryable admission contract installed bridges already retry,
        // keeping the observer code as a diagnostic (VUH-2208).
        if (error instanceof RemoteObservationError)
          return { denial: fleetAdmissionUnavailableResponse({ observation: error.code }) };
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

  // A fleet pane's evidence (VUH-2923). The seat proves itself as a peer sender
  // does and becomes the record's actor; the bytes follow to the store's own
  // signed upload path on the same link, so no proof runs while they stream.
  const seatEvidence = async (
    context: Context,
    use: (
      store: NonNullable<typeof ctx.dependencies.evidenceStore>,
      actor: import("@clankie/protocol/evidence").EvidenceActor,
    ) => Promise<unknown>,
  ): Promise<Response> => {
    try {
      const authority = await peerSeatAuthority(context);
      if (!authority) return context.json({ error: "native_seat_required" }, 403);
      const store = ctx.dependencies.evidenceStore;
      if (!store) return context.json({ error: "evidence_store_unavailable" }, 503);
      const actor = await ctx.dependencies.captain.fleetSeatEvidenceActor(authority);
      if (!actor) return context.json({ error: "native_seat_required" }, 403);
      return context.json(await use(store, actor));
    } catch (error) {
      if (error instanceof RemoteObservationError)
        return fleetAdmissionUnavailableResponse({ observation: error.code });
      if (error instanceof EvidenceRefusal) return context.json({ error: error.code }, error.status);
      if (error instanceof SyntaxError) return context.json({ error: "invalid_request" }, 400);
      throw error;
    }
  };
  ctx.app.post(FLEET_EVIDENCE_UPLOADS_PATH, bodyLimit({ maxSize: 64 * 1024 }), (context) =>
    seatEvidence(context, async (store, actor) => store.upload(actor, await context.req.json())),
  );
  ctx.app.get(`${FLEET_EVIDENCE_UPLOADS_PATH}/:receiptId`, (context) => {
    context.header("cache-control", "no-store");
    return seatEvidence(context, (store, actor) => store.lookup(actor, context.req.param("receiptId")));
  });

  // The standing review gate (ADR 0287): the author submits and the reviewer
  // decides from their own native seats; the service hashes and routes both.
  ctx.app.post(
    FLEET_REVIEW_CANDIDATES_PATH,
    bodyLimit({ maxSize: Math.ceil(REVIEW_PATCH_MAX_BYTES / 3) * 4 + 64 * 1024 }),
    async (context) => {
      const authority = await peerSeatAuthority(context);
      if (!authority) return context.json({ error: "native_seat_required" }, 403);
      const reviews = ctx.dependencies.captain.reviews;
      if (!reviews) return context.json({ error: "reviews_unavailable" }, 503);
      // allow-swallowed-rejection -- A malformed body is refused below as an invalid submission.
      const input = ReviewSubmissionSchema.safeParse(await context.req.json().catch(() => undefined));
      if (!input.success) return context.json({ error: "invalid_review_submission" }, 400);
      const result = await reviews.submit(authority, input.data);
      return "error" in result
        ? context.json(result, reviewRefusalStatus(result))
        : context.json({ schemaVersion: 1, candidate: result });
    },
  );
  ctx.app.get(`${FLEET_REVIEW_CANDIDATES_PATH}/:id`, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await peerSeatAuthority(context);
    if (!authority) return context.json({ error: "native_seat_required" }, 403);
    const reviews = ctx.dependencies.captain.reviews;
    if (!reviews) return context.json({ error: "reviews_unavailable" }, 503);
    const id = z.string().uuid().safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "unknown_candidate" }, 404);
    const result = await reviews.read(authority, id.data);
    return "error" in result
      ? context.json(result, reviewRefusalStatus(result))
      : context.json({ schemaVersion: 1, ...result });
  });
  ctx.app.post(FLEET_REVIEW_VERDICTS_PATH, bodyLimit({ maxSize: 256 * 1024 }), async (context) => {
    const authority = await peerSeatAuthority(context);
    if (!authority) return context.json({ error: "native_seat_required" }, 403);
    const reviews = ctx.dependencies.captain.reviews;
    if (!reviews) return context.json({ error: "reviews_unavailable" }, 503);
    // allow-swallowed-rejection -- A malformed body is refused below as an invalid verdict.
    const input = ReviewVerdictInputSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success)
      return context.json(
        {
          error: "invalid_review_verdict",
          detail: input.error.issues.map((issue) => issue.message).join("; "),
        },
        400,
      );
    const result = await reviews.verdict(authority, input.data);
    return "error" in result
      ? context.json(result, reviewRefusalStatus(result))
      : context.json({ schemaVersion: 1, candidate: result });
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
      // A catalog change ends the parked poll; the revision below tells the
      // bridge to list its tools only then, rather than on a timer (VUH-2062).
      const worker = ctx.dependencies.workerMcp;
      const catalogChanged = worker?.catalogChanges();
      const events = await ctx.dependencies.captain.pollFleetSeatEvents(
        pane.paneId,
        waitMs,
        catalogChanged ? AbortSignal.any([context.req.raw.signal, catalogChanged]) : context.req.raw.signal,
      );
      if (events === undefined) return context.json({ error: "unknown_seat" }, 404);
      if (worker) {
        const qualified = splitFleetQualified(pane.paneId);
        context.header(
          FLEET_CATALOG_REVISION_HEADER,
          await worker.catalogRevision(qualified?.fleet ?? "default", qualified?.id ?? pane.paneId),
        );
      }
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
        ? context.json({
            schemaVersion: 1,
            acknowledged: true,
            eventId: context.req.param("id"),
            deliveryStage: "delivered",
          })
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
  ctx.app.get(`${FLEET_SEAT_MESSAGES_PATH}/:id/status`, async (context) => {
    context.header("cache-control", "no-store");
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const id = z.string().uuid().safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "invalid_request" }, 400);
    const identity =
      ctx.dependencies.localFleet?.identity(context.req.raw) ??
      ctx.dependencies.fleetLinks?.identity?.(context.req.raw);
    const status = await ctx.dependencies.captain.fleetSeatMessageStatus(pane.paneId, id.data);
    if (identity && !(await identity.validate()))
      return context.json({ error: "native_session_required" }, 403);
    if (!status) return context.json({ error: "unknown_message_receipt" }, 404);
    // Bridges released before `definitive` reject unknown keys; only readers that ask get it.
    const { definitive, ...stage } = FleetSeatMessageStatusSchema.parse(status);
    return context.json(
      context.req.query("definitive") === "1" && definitive !== undefined ? { ...stage, definitive } : stage,
    );
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
      parsed.data.urgent === true ? { urgent: true } : undefined,
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
  // A bridge without the seat channel (Codex, or Claude started without
  // --channels) long-polls its catalog revision here instead of listing its
  // tools on a timer (VUH-2390). It never reads or binds the seat's mailbox.
  ctx.app.get(FLEET_SEAT_TOOL_CATALOG_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const worker = ctx.dependencies.workerMcp;
    if (!worker) return context.json({ error: "worker_catalog_unavailable" }, 503);
    const wait = Number(context.req.query("wait") ?? 0);
    const qualified = splitFleetQualified(pane.paneId);
    const revision = await worker.waitCatalogRevision(
      qualified?.fleet ?? "default",
      qualified?.id ?? pane.paneId,
      context.req.query("revision"),
      Number.isFinite(wait) ? Math.min(Math.max(0, Math.trunc(wait)), OPERATOR_SEAT_EVENT_WAIT_MS_MAX) : 0,
      context.req.raw.signal,
    );
    context.header(FLEET_CATALOG_REVISION_HEADER, revision);
    return context.json({ schemaVersion: 1, revision });
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
  ctx.app.post("/v1/fleet/seats/:paneId/permission", bodyLimit({ maxSize: 64 * 1024 }), async (context) => {
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const request = ClaudeChannelPermissionRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    const bridge = z.string().uuid().safeParse(context.req.header("x-clankie-bridge-id"));
    if (!request.success || !bridge.success)
      return context.json({ error: "invalid_native_permission_request" }, 400);
    const result = await ctx.dependencies.captain.recordSeatPermission(
      pane.paneId,
      request.data,
      bridge.data,
      context.req.raw.signal,
    );
    return result
      ? context.json({ schemaVersion: 1, requestId: request.data.request_id, ...result })
      : context.json({ error: "native_permission_unavailable" }, 404);
  });

  ctx.app.post(FLEET_SEAT_HOOK_PATH, bodyLimit({ maxSize: 128 * 1024 }), async (context) => {
    const pane = await fleetSeatPane(context);
    if ("denial" in pane) return pane.denial;
    const parsed = FleetSeatHookSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const identity =
      ctx.dependencies.localFleet?.identity(context.req.raw) ??
      ctx.dependencies.fleetLinks?.identity?.(context.req.raw);
    const proof = identity && (await identity.validate()) ? await identity.projectProof?.() : undefined;
    if (parsed.data.event === "NativeActivity") {
      if (!identity || !proof || !(await identity.validate()))
        return context.json({ error: "native_session_required" }, 403);
      const recorded = await ctx.dependencies.fleetResources?.recordNativeActivity(
        pane.paneId,
        parsed.data,
        proof,
      );
      return recorded
        ? context.json({ schemaVersion: 1, recorded: true })
        : context.json({ error: "native_activity_refused" }, 403);
    }
    // Question hooks may hold their response; observe finite activity on arrival.
    if (identity && proof && (await identity.validate()))
      await ctx.dependencies.fleetResources?.recordRootHook(pane.paneId, parsed.data, proof);
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
    // A bearer grants the operator's stateless tools, not a conversation. In
    // particular, the CLI must never resolve an omitted ID to global-default.
    // Naming a conversation still requires the launcher's native binding below.
    if (auth.lane === "operator" && context.req.query("conversationId") === undefined)
      return laneMcp.handle(context.req.raw, auth.lane);
    const unbound = await refuseUnboundOperator(context, auth.lane);
    if (unbound !== undefined) return unbound;
    const binding = seatBinding(context, auth.lane);
    if ("denial" in binding) return binding.denial;
    return laneMcp.handle(context.req.raw, auth.lane, binding.conversationId);
  });
  return { laneMcp };
}
