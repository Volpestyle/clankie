import { z } from "zod";
import { DeliveryStageSchema } from "./delivery.ts";

/**
 * The fleet room (VUH-2184): one time-ordered, read-only feed of how the fleet
 * coordinates — lead briefs, worker reports, peer and lead-to-lead messages,
 * Auto rounds and owner questions — recorded by the host as each happens. It
 * is display only: an entry grants no authority, and an owner reply goes to
 * the head through the ordinary `send` path, never to a worker named here.
 * History from before a host recorded the room is not reconstructed.
 */
export const FLEET_ROOM_PAGE_MAX = 100;
/** How long a `newer` read may wait for the next entry. */
export const FLEET_ROOM_WAIT_MAX_MS = 20_000;
export const FLEET_ROOM_TEXT_MAX = 2000;
/** An inbound arrival carries a short excerpt, never the whole delivery. */
export const FLEET_ROOM_INBOUND_EXCERPT_MAX = 280;

export const FleetRoomKindSchema = z.enum([
  /** A lead's brief or message to one of its workers. */
  "lead_message",
  /** A worker's report to its lead (`message_clankie`). */
  "worker_report",
  /** One worker to another (`message_peer`). */
  "peer_message",
  /** One lead to another lead's conversation. */
  "lead_to_lead",
  /** Clankie's Auto round, delivered to the lead that runs the projects. */
  "auto_round",
  /** A question waiting on the owner. */
  "owner_question",
  /** That question answered or withdrawn. */
  "owner_answer",
  /** A webhook or message from outside the fleet that reached him: a Linear comment, a Discord message. */
  "inbound",
]);
export type FleetRoomKind = z.infer<typeof FleetRoomKindSchema>;

const id = z.string().trim().min(1).max(200);

/** Who said it, or who it was for. Labels are display names, never authority. */
export const FleetRoomPartySchema = z.strictObject({
  /** `external` is a person outside the fleet who is not the owner, such as another Linear or Discord user. */
  kind: z.enum(["lead", "worker", "clankie", "owner", "external"]),
  label: z.string().trim().min(1).max(120),
  conversationId: id.optional(),
  seatId: id.optional(),
  personaId: id.optional(),
});
export type FleetRoomParty = z.infer<typeof FleetRoomPartySchema>;

const issueKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}(?:-[A-Z][A-Z0-9]{1,9})?-\d{1,7}$/u);

/** Where an `inbound` entry came from and what it points at. */
export const FleetRoomInboundSchema = z.strictObject({
  channel: z.enum(["linear", "discord", "github"]),
  /** The issue the delivery is about, as the source stated it; never inferred from its text. */
  issue: issueKey.optional(),
  /** Opens the source: the Linear comment or issue, or the Discord message. */
  url: z
    .string()
    .url()
    .max(2048)
    .refine((url) => url.startsWith("https://"), "Inbound links are https")
    .optional(),
});
export type FleetRoomInbound = z.infer<typeof FleetRoomInboundSchema>;

export const FleetRoomEntrySchema = z
  .strictObject({
    /** The source's own stable id (delivery, question or round), so a replay never duplicates a line. */
    id,
    /** The host's order; cursors are sequences. */
    sequence: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    kind: FleetRoomKindSchema,
    from: FleetRoomPartySchema,
    to: FleetRoomPartySchema.nullable(),
    text: z.string().max(FLEET_ROOM_TEXT_MAX),
    /** Issue keys and commit SHAs the text itself names; nothing is inferred beyond it. */
    links: z.strictObject({
      issues: z.array(issueKey).max(12),
      commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/u)).max(12),
    }),
    /** The conversation the line belongs to, when the app can open it. */
    thread: z.strictObject({ conversationId: id }).optional(),
    /** Receipt progress when recorded (ADR 0211): stored is not delivered, delivered is not read. */
    delivery: z.strictObject({ stage: DeliveryStageSchema }).optional(),
    /** Present exactly on `inbound` entries. */
    inbound: FleetRoomInboundSchema.optional(),
  })
  .refine((entry) => (entry.kind === "inbound") === (entry.inbound !== undefined), {
    message: "Only inbound entries carry inbound source facts, and every inbound entry does",
    path: ["inbound"],
  });
export type FleetRoomEntry = z.infer<typeof FleetRoomEntrySchema>;

const cursor = z.string().regex(/^\d{1,15}$/u);

export const FleetRoomRequestSchema = z.strictObject({
  op: z.literal("fleet_room"),
  schemaVersion: z.literal(1),
  /**
   * `older` reads the page before `cursor` (the latest page without one);
   * `newer` reads entries after it, waiting up to `waitMs` for the first.
   */
  direction: z.enum(["older", "newer"]).default("older"),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(FLEET_ROOM_PAGE_MAX).default(50),
  waitMs: z.number().int().min(0).max(FLEET_ROOM_WAIT_MAX_MS).default(0),
});
export type FleetRoomRequest = z.input<typeof FleetRoomRequestSchema>;

export const FleetRoomResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("ready"),
    /** Oldest first. */
    entries: z.array(FleetRoomEntrySchema).max(FLEET_ROOM_PAGE_MAX),
    /** Pass with `older` for the page before these; null when there is nothing older. */
    older: cursor.nullable(),
    /** Pass with `newer` to follow the room from here. */
    newer: cursor,
    /** When this host started recording the room; nothing earlier exists. */
    recordingSince: z.string().datetime({ offset: true }).nullable(),
  }),
  z.strictObject({ outcome: z.literal("unavailable"), message: z.string().min(1).max(500) }),
]);
export type FleetRoomResult = z.infer<typeof FleetRoomResultSchema>;
