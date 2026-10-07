import { z } from "zod";
import {
  OPERATOR_CONVERSATION_REF_MAX,
  OperatorConversationIdSchema,
  OPERATOR_CONVERSATION_CODE_MAX,
  OPERATOR_CONVERSATION_TEXT_MAX,
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  OPERATOR_CONVERSATION_TITLE_MAX,
  OPERATOR_FLEET_ROSTER_MAX,
} from "./operator-conversations.ts";

// ---------------------------------------------------------------------------
// The seat's head and its outbox (ADR 0152).
//
// A harness sitting in the operator seat is his head. The service tells a
// seated herdr pane from a fleet contact by one name, and hands the seat its
// wakes, watches, and escalations through one long-polled outbox.
// ---------------------------------------------------------------------------

/** The herdr agent name that makes a pane Clankie's own head rather than a fleet contact. */
export const OPERATOR_HEAD_AGENT_NAME = "clankie";
/** Long-polled by the seat's stdio bridge; each event becomes one channel notification. */
export const OPERATOR_SEAT_EVENTS_PATH = "/v1/seat/events";
export const OPERATOR_SEAT_EVENT_WAIT_MS_MAX = 30_000;
/**
 * `message` carries a fleet seat's DM or room turn, or an authenticated worker
 * report to its leading conversation. Its content grants no new authority.
 */
export const OperatorSeatEventKindSchema = z.enum(["wake", "watch", "escalation", "message"]);
export type OperatorSeatEventKind = z.infer<typeof OperatorSeatEventKindSchema>;
export const OperatorSeatEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    kind: OperatorSeatEventKindSchema,
    conversationId: OperatorConversationIdSchema,
    /** Who handed the head this: `service` for his own wakes and watches, otherwise the sending surface. */
    source: z.string().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
    content: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
    createdAt: z.string().min(1),
  })
  .strict();
export type OperatorSeatEvent = z.infer<typeof OperatorSeatEventSchema>;
export const OperatorSeatEventsPageSchema = z
  .object({ schemaVersion: z.literal(1), events: z.array(OperatorSeatEventSchema).max(64) })
  .strict();
export type OperatorSeatEventsPage = z.infer<typeof OperatorSeatEventsPageSchema>;
/**
 * A fleet seat's mailbox: the same page shape, one per herdr pane, long-polled
 * by `clankie mcp --seat` from inside that pane. The bridge names the pane it
 * sits in (its `HERDR_PANE_ID`); the service resolves that to the seat it
 * already messages. While a bridge is polling, a message to that seat rides
 * this mailbox as a channel event instead of being typed into the pane's pty,
 * so nothing the operator has half-typed there is appended to or submitted.
 */
export const FLEET_SEAT_EVENTS_PATH = "/v1/fleet/seats/:paneId/events";
export function fleetSeatEventsPath(paneId: string): string {
  return `/v1/fleet/seats/${encodeURIComponent(paneId)}/events`;
}
/** The MCP server name a fleet seat's harness loads the channel from (`server:` form of the channels flag). */
export const FLEET_SEAT_MCP_SERVER = "clankie-seat";
/**
 * The Claude worker plugin a hired seat is driven through (VUH-1458): its
 * channel carries the seat's mailbox, and its hooks report each settled turn.
 * The owner approves this exact installed identity in managed policy once.
 */
export const CLAUDE_WORKER_PLUGIN = { plugin: "clankie-worker", marketplace: "clankie" } as const;
export const CLAUDE_WORKER_PLUGIN_ID = `${CLAUDE_WORKER_PLUGIN.plugin}@${CLAUDE_WORKER_PLUGIN.marketplace}`;
/**
 * One lifecycle hook from a hired seat's worker plugin, reported by
 * `clankie seat-hook` from inside its pane. `lastMessage` is the harness's own
 * final text for a settled turn; `error` names a StopFailure.
 */
export const FleetSeatHookSchema = z
  .object({
    schemaVersion: z.literal(1),
    event: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "PreToolUse",
      "PermissionRequest",
      "Notification",
      "PostToolUse",
      "SessionEnd",
    ]),
    toolName: z.string().min(1).max(200).optional(),
    toolUseId: z.string().min(1).max(256).optional(),
    toolInput: z.record(z.string(), z.unknown()).optional(),
    notificationType: z.string().max(100).optional(),
    sessionId: z.string().min(1).max(200),
    deliveredQuestionId: z.string().min(1).max(256).optional(),
    deliveredMessageIds: z.array(z.string().uuid()).max(100).optional(),
    lastMessage: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX).optional(),
    error: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
  })
  .strict();
export type FleetSeatHook = z.infer<typeof FleetSeatHookSchema>;
export const FLEET_SEAT_HOOK_PATH = "/v1/fleet/seats/:paneId/hook";
export function fleetSeatHookPath(paneId: string): string {
  return `/v1/fleet/seats/${encodeURIComponent(paneId)}/hook`;
}
/**
 * An agent in a fleet pane writing to Clankie (ADR 0213 phase 2): hired or not,
 * local or on a linked machine. It reaches him as untrusted agent output, the
 * way a completion watch does, and grants the sender nothing; he answers, if
 * he chooses, with `message_seat`.
 */
export const FleetSeatMessageDeliverySchema = z
  .object({
    id: z.string().uuid(),
    binding: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type FleetSeatMessageDelivery = z.infer<typeof FleetSeatMessageDeliverySchema>;
export const FleetSeatMessageReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    received: z.boolean(),
    deliveryStage: z.enum(["stored", "uncertain", "rejected", "unavailable"]),
    deliveryId: z.string().uuid(),
    binding: z.string().regex(/^[a-f0-9]{64}$/u),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    detail: z.string().optional(),
    /** Authenticated lookup sealed this ID against any delayed original POST. */
    definitive: z.literal("not_sent").optional(),
  })
  .strict();
export type FleetSeatMessageReceipt = z.infer<typeof FleetSeatMessageReceiptSchema>;
export const FleetSeatMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    text: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TEXT_MAX),
    /** Optional on decode for legacy clients; current HTTP writes require it. */
    delivery: FleetSeatMessageDeliverySchema.optional(),
  })
  .strict();
export type FleetSeatMessage = z.infer<typeof FleetSeatMessageSchema>;
export const FLEET_SEAT_MESSAGES_PATH = "/v1/fleet/seats/:paneId/messages";
export function fleetSeatMessagesPath(paneId: string): string {
  return `/v1/fleet/seats/${encodeURIComponent(paneId)}/messages`;
}
/** Peer messages carry no operator authority and never cross a fleet boundary. */
export const FleetPeerSeatSchema = z
  .object({
    seatId: z.string().min(1).max(200),
    paneId: z.string().min(1).max(200),
    binding: z.string().regex(/^[a-f0-9]{64}$/u),
    harness: z.string().min(1).max(80),
    title: z.string().max(OPERATOR_CONVERSATION_TITLE_MAX),
  })
  .strict();
export const FleetPeerSeatsSchema = z
  .object({
    schemaVersion: z.literal(1),
    fleet: z.string().min(1).max(64),
    sender: FleetPeerSeatSchema,
    seats: z.array(FleetPeerSeatSchema).max(OPERATOR_FLEET_ROSTER_MAX),
  })
  .strict();
export type FleetPeerSeats = z.infer<typeof FleetPeerSeatsSchema>;
export const FleetPeerMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    seatId: z.string().min(1).max(200),
    recipientBinding: z.string().regex(/^[a-f0-9]{64}$/u),
    text: z.string().trim().min(1).max(32_768),
    delivery: FleetSeatMessageDeliverySchema,
  })
  .strict();
export type FleetPeerMessage = z.infer<typeof FleetPeerMessageSchema>;
export const FleetPeerReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    deliveryId: z.string().uuid(),
    binding: z.string().regex(/^[a-f0-9]{64}$/u),
    seatId: z.string().min(1).max(200),
    recipientBinding: z.string().regex(/^[a-f0-9]{64}$/u),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    deliveryStage: z.enum([
      "stored",
      "delivered",
      "consumed",
      "uncertain",
      "recipient_gone",
      "rejected",
      "unavailable",
    ]),
    outcome: z.enum(["delivered", "unconfirmed", "undelivered", "offline"]),
    detail: z.string().optional(),
    messageId: z.string().optional(),
    state: z.enum(["queued", "started", "steered"]).optional(),
  })
  .strict()
  .refine((receipt) => receipt.deliveryStage !== "recipient_gone" || receipt.outcome === "unconfirmed", {
    path: ["outcome"],
    message: "A recipient-gone receipt retains an unknown delivery outcome",
  });
export type FleetPeerReceipt = z.infer<typeof FleetPeerReceiptSchema>;
export const FLEET_PEER_SEATS_PATH = "/v1/fleet/seats/:paneId/peers";
export const FLEET_PEER_MESSAGES_PATH = "/v1/fleet/seats/:paneId/peer-messages";
/**
 * The link a machine on an ssh fleet uses to reach Clankie (VUH-1527): his
 * service through a reverse ssh forward on that machine's loopback, and a
 * token that authorizes only the seat routes above, only for panes on that
 * fleet. One machine can host several fleets (one per Herdr session), so
 * Clankie writes each as `~/.clankie/links/<fleet>.json`, readable by its owner
 * only, naming that session's socket; a pane's bridge takes the link whose
 * socket is its own `HERDR_SOCKET_PATH`. It is replaced whenever the link
 * reconnects.
 */
export const FleetLinkFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    fleet: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    /** The fleet's Herdr socket on that machine, as its panes see it. */
    socket: z.string().min(1).max(1024),
    url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/u),
    token: z.string().min(32).max(200),
  })
  .strict();
export type FleetLinkFile = z.infer<typeof FleetLinkFileSchema>;

/** The seat's answer to one escalation; it lands in the conversation as his reply. */
export const OperatorSeatReplySchema = z
  .object({ schemaVersion: z.literal(1), text: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TEXT_MAX) })
  .strict();
export type OperatorSeatReply = z.infer<typeof OperatorSeatReplySchema>;
