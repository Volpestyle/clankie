import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DiscordRoomGuidanceSchema,
  DiscordRoomStatusSchema,
  type DiscordRoomEvidence,
  type DiscordRoomGuidance,
  type DiscordRoomStatus,
} from "@clankie/protocol";

const Delivery = z.object({
  id: z.string(),
  outcomes: z.array(z.string()),
  replyDeliveryId: z.string().optional(),
});
const SavedRoom = z.object({ status: DiscordRoomStatusSchema, deliveries: z.array(Delivery).max(4096) });
const Saved = z.object({ rooms: z.array(SavedRoom).max(512) });
type Room = z.infer<typeof SavedRoom>;
/** Content-free delivery health and a separate owner-private guidance slot. Neither grants room authority. */
export class DiscordRoomObservations {
  private readonly rooms = new Map<string, Room>();
  private readonly guidanceGuards = new Map<string, { guard: () => Promise<void>; current: () => boolean }>();
  private readonly listeners = new Set<(conversationId: string) => void>();
  private readonly file: string;
  private readonly now: () => Date;
  constructor(file: string, now = () => new Date()) {
    this.file = file;
    this.now = now;
    if (!existsSync(file)) return;
    const saved = Saved.parse(JSON.parse(readFileSync(file, "utf8")));
    for (const room of saved.rooms) {
      // A persisted text is not persisted authority. A restarted process cannot
      // reconstruct the original device bearer/local operator authentication.
      if (room.status.guidance.state === "pending")
        room.status.guidance = { ...room.status.guidance, state: "expired", text: undefined };
      this.rooms.set(room.status.conversationId, room);
    }
  }
  observeFailures(listener: (conversationId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  status(conversationId: string): DiscordRoomStatus {
    return structuredClone(this.rooms.get(conversationId)?.status ?? this.empty(conversationId).status);
  }
  list(): DiscordRoomStatus[] {
    return [...this.rooms.values()].map((room) => structuredClone(room.status));
  }
  record(conversationId: string, evidence: DiscordRoomEvidence): void {
    const room = structuredClone(this.rooms.get(conversationId) ?? this.empty(conversationId));
    let delivery = room.deliveries.find((entry) => entry.id === evidence.deliveryId);
    if (!delivery) {
      delivery = { id: evidence.deliveryId, outcomes: [] };
      room.deliveries.push(delivery);
    }
    if (delivery.outcomes.includes(evidence.outcome)) return;
    const firstFailure = !delivery.outcomes.some(
      (outcome) => outcome === "failed" || outcome === "escalated",
    );
    delivery.outcomes.push(evidence.outcome);
    if (evidence.replyDeliveryId) delivery.replyDeliveryId = evidence.replyDeliveryId;
    const status = room.status;
    status.coverage = "observed";
    status.lastObservedAt = this.now().toISOString();
    if (evidence.reason) status.lastReason = evidence.reason;
    if (evidence.outcome === "declined") status.lastReason = evidence.reason ?? "volitional_silence";
    // A rolling bounded window is explicit: counters cover only retained deliveries.
    room.deliveries = room.deliveries.slice(-4096);
    const has = (entry: z.infer<typeof Delivery>, ...outcomes: string[]) =>
      outcomes.some((outcome) => entry.outcomes.includes(outcome));
    status.received = room.deliveries.length;
    status.answered = room.deliveries.filter(
      (entry) =>
        has(entry, "settled") ||
        (entry.replyDeliveryId !== undefined &&
          room.deliveries.some((reply) => reply.id === entry.replyDeliveryId && has(reply, "settled"))),
    ).length;
    status.silent = room.deliveries.filter((entry) => has(entry, "declined")).length;
    status.missed = room.deliveries.filter((entry) => has(entry, "missed")).length;
    status.failed = room.deliveries.filter((entry) => has(entry, "failed")).length;
    status.pending = room.deliveries.filter(
      (entry) => !has(entry, "settled", "declined", "missed", "failed", "absorbed", "dropped", "escalated"),
    ).length;
    status.absorbedUnknown = room.deliveries.filter(
      (entry) =>
        has(entry, "absorbed") &&
        !(
          entry.replyDeliveryId &&
          room.deliveries.some((reply) => reply.id === entry.replyDeliveryId && has(reply, "settled"))
        ),
    ).length;
    this.commit(conversationId, room);
    if (firstFailure && (evidence.outcome === "failed" || evidence.outcome === "escalated"))
      for (const listener of this.listeners) listener(conversationId);
  }
  setGuidance(
    conversationId: string,
    text: string | undefined,
    expectedRevision: number,
    guard: () => Promise<void>,
    current: () => boolean = () => true,
  ): DiscordRoomGuidance {
    const room = structuredClone(this.rooms.get(conversationId) ?? this.empty(conversationId));
    if (room.status.guidance.revision !== expectedRevision) throw new Error("guidance_revision_conflict");
    room.status.guidance = DiscordRoomGuidanceSchema.parse({
      revision: expectedRevision + 1,
      state: text === undefined ? "empty" : "pending",
      text,
      updatedAt: this.now().toISOString(),
    });
    this.commit(conversationId, room);
    if (text === undefined) this.guidanceGuards.delete(conversationId);
    else this.guidanceGuards.set(conversationId, { guard, current });
    return structuredClone(room.status.guidance);
  }
  /** Authorization may await; the returned commit is synchronous at actual prompt submission. */
  async prepare(
    conversationId: string,
    sourceCurrent: () => boolean,
    sourceAuthorize: () => Promise<boolean> = async () => true,
  ): Promise<() => string | undefined> {
    const pending = this.rooms.get(conversationId)?.status.guidance;
    if (pending?.state !== "pending") return () => undefined;
    const guard = this.guidanceGuards.get(conversationId);
    let authorized = guard !== undefined;
    try {
      await guard?.guard();
      authorized &&= await sourceAuthorize();
    } catch {
      authorized = false;
    }
    return () => {
      const current = this.rooms.get(conversationId);
      if (
        !current ||
        current.status.guidance.revision !== pending.revision ||
        current.status.guidance.state !== "pending" ||
        this.guidanceGuards.get(conversationId) !== guard
      )
        return undefined;
      const room = structuredClone(current);
      authorized &&= guard?.current() === true && sourceCurrent();
      room.status.guidance = { ...pending, state: authorized ? "consumed" : "expired", text: undefined };
      this.commit(conversationId, room);
      this.guidanceGuards.delete(conversationId);
      return authorized ? pending.text : undefined;
    };
  }
  async consume(
    conversationId: string,
    sourceCurrent: () => boolean,
    sourceAuthorize: () => Promise<boolean> = async () => true,
  ): Promise<string | undefined> {
    return (await this.prepare(conversationId, sourceCurrent, sourceAuthorize))();
  }
  private empty(conversationId: string): Room {
    return {
      status: {
        conversationId,
        coverage: "unknown",
        since: this.now().toISOString(),
        received: 0,
        answered: 0,
        silent: 0,
        missed: 0,
        failed: 0,
        pending: 0,
        absorbedUnknown: 0,
        guidance: { revision: 0, state: "empty" },
      },
      deliveries: [],
    };
  }
  private commit(id: string, room: Room): void {
    const entries = new Map(this.rooms);
    entries.set(id, room);
    if (entries.size > 512) throw new Error("room_observation_capacity");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ rooms: [...entries.values()] }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
    const directory = openSync(dirname(this.file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.rooms.set(id, room);
  }
}
