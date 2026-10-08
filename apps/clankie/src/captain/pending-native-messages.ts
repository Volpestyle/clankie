import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  PendingNativeMessageSchema,
  type PendingNativeMessage,
  type PendingNativeMessageAction,
  type PendingNativeMessagesResult,
  type StopNativeTaskResult,
} from "@clankie/protocol";
import type { FleetSeatDelivery } from "./fleet-seat.ts";

export interface NativeMessageHost {
  inspect(seatId: string): Promise<{ binding: string; status: string; queueSupported?: boolean } | undefined>;
  send(
    seatId: string,
    text: string,
    messageId: string,
    conversationId: string,
    guard: () => Promise<void>,
  ): Promise<FleetSeatDelivery>;
  stop(seatId: string, binding: string, guard: () => Promise<void>): Promise<StopNativeTaskResult>;
}
const RecordSchema = PendingNativeMessageSchema.extend({
  seatId: z.string(),
  binding: z.string(),
  attachmentNote: z.string().optional(),
}).strict();
type Record = z.infer<typeof RecordSchema>;

/** Host-owned originals. A dispatched or uncertain original is never a resend queue. */
export class PendingNativeMessages {
  private records: Record[] = [];
  private readonly authorities = new Map<string, () => Promise<void>>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private pumping = false;
  private readonly path: string;
  private readonly host: NativeMessageHost;
  private readonly settled: ((message: PendingNativeMessage) => void) | undefined;
  constructor(path: string, host: NativeMessageHost, settled?: (message: PendingNativeMessage) => void) {
    this.path = path;
    this.host = host;
    this.settled = settled;
    try {
      this.records = z
        .array(RecordSchema)
        .max(1000)
        .parse(JSON.parse(readFileSync(path, "utf8")));
      for (const record of this.records)
        if (record.state === "dispatching") {
          record.state = "uncertain";
          record.detail = "Service restarted across dispatch; this original is never resent.";
        }
      this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Restored queued records remain host-owned but need a fresh explicit send-now
    // authority. An expired device session or service restart never grants a send.
    this.timer = setInterval(() => {
      void this.pump().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  list(conversationId: string): PendingNativeMessage[] {
    return this.records
      .filter((r) => r.conversationId === conversationId)
      .map(({ seatId: _seat, binding: _binding, attachmentNote: _note, ...r }) => structuredClone(r));
  }
  async enqueue(
    conversationId: string,
    seatId: string,
    text: string,
    authorize: () => Promise<void>,
    attachmentNote?: string,
  ): Promise<PendingNativeMessage | undefined> {
    await authorize();
    const observed = await this.host.inspect(seatId);
    await authorize();
    if (!observed || observed.queueSupported === false || this.closed) return undefined;
    const records = this.records.filter((r) => r.conversationId === conversationId);
    if (
      records.filter((r) => r.state === "queued" || r.state === "dispatching" || r.state === "uncertain")
        .length >= 100
    )
      throw new RangeError("Pending native message limit reached");
    while (this.records.filter((r) => r.conversationId === conversationId).length >= 100) {
      const expired = this.records.findIndex(
        (r) =>
          r.conversationId === conversationId && !["queued", "dispatching", "uncertain"].includes(r.state),
      );
      if (expired < 0) throw new RangeError("Pending native message limit reached");
      this.records.splice(expired, 1);
    }
    const record: Record = {
      messageId: `run-${randomUUID()}`,
      conversationId,
      seatId,
      binding: observed.binding,
      text,
      ...(attachmentNote ? { attachmentNote } : {}),
      version: 0,
      createdAt: new Date().toISOString(),
      state: "queued",
    };
    if (this.records.length >= 1000) {
      const expired = this.records.findIndex(
        (r) => !["queued", "dispatching", "uncertain"].includes(r.state),
      );
      if (expired < 0) throw new RangeError("Host pending native message limit reached");
      this.records.splice(expired, 1);
    }
    RecordSchema.parse(record);
    this.records.push(record);
    this.save();
    this.authorities.set(record.messageId, authorize);
    return this.list(conversationId).find((r) => r.messageId === record.messageId);
  }
  async action(
    conversationId: string,
    command: PendingNativeMessageAction,
    authorize: () => Promise<void>,
    currentSeat: () => string | undefined,
  ): Promise<PendingNativeMessagesResult> {
    await authorize();
    const result = (
      outcome: PendingNativeMessagesResult["outcome"],
      detail?: string,
    ): PendingNativeMessagesResult => ({
      outcome,
      messages: this.list(conversationId),
      ...(detail ? { detail } : {}),
    });
    if (command.action === "list") return result("listed");
    const record = this.records.find(
      (r) => r.conversationId === conversationId && r.messageId === command.messageId,
    );
    if (!record || record.version !== command.expectedVersion || record.state !== "queued")
      return result("conflict", "The original changed or was already picked up; read its current outcome.");
    const observed = await this.host.inspect(record.seatId);
    await authorize();
    if (record.version !== command.expectedVersion || record.state !== "queued") return result("conflict");
    if (currentSeat() !== record.seatId || observed?.binding !== record.binding)
      return result(
        "unavailable",
        "The conversation's original native occupant changed; no action was sent.",
      );
    if (command.action === "remove") {
      record.state = "removed";
      record.version++;
      this.save();
      this.authorities.delete(record.messageId);
      this.settled?.(record);
      return result("removed");
    }
    if (command.action === "edit") {
      record.text = command.text;
      record.version++;
      this.save();
      return result("edited");
    }
    await this.dispatch(record, authorize, currentSeat);
    const state = this.list(conversationId).find((r) => r.messageId === record.messageId)?.state;
    return result(
      state === "picked_up"
        ? "picked_up"
        : state === "uncertain" || state === "dispatching"
          ? "uncertain"
          : "unavailable",
    );
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      const seen = new Set<string>();
      for (const record of this.records) {
        if (seen.has(record.conversationId)) continue;
        if (record.state === "uncertain" || record.state === "dispatching") {
          seen.add(record.conversationId);
          continue;
        }
        if (record.state !== "queued") continue;
        seen.add(record.conversationId);
        const authorize = this.authorities.get(record.messageId);
        if (!authorize) continue;
        const observed = await this.host.inspect(record.seatId);
        if (observed?.status !== "idle") continue;
        await this.dispatch(record, authorize);
      }
    } finally {
      this.pumping = false;
    }
  }
  private async dispatch(
    record: Record,
    authorize: () => Promise<void>,
    currentSeat?: () => string | undefined,
  ): Promise<void> {
    if (record.state !== "queued" || this.closed) return;
    // Lock this original before any await; edit/remove and another sender lose.
    record.state = "dispatching";
    record.version++;
    this.save();
    let began = false;
    const guard = async () => {
      await authorize();
      const observed = await this.host.inspect(record.seatId);
      await authorize();
      if (
        this.closed ||
        observed?.binding !== record.binding ||
        (currentSeat && currentSeat() !== record.seatId)
      )
        throw new Error("Original native binding or authority changed; nothing was sent.");
      began = true;
    };
    const run = (async () => {
      try {
        await guard();
        const receipt = await this.host.send(
          record.seatId,
          [record.text, record.attachmentNote].filter(Boolean).join("\n\n"),
          record.messageId,
          record.conversationId,
          guard,
        );
        record.state =
          receipt.outcome === "delivered" && receipt.state !== "queued"
            ? "picked_up"
            : receipt.outcome === "unconfirmed" ||
                (receipt.outcome === "delivered" && receipt.state === "queued")
              ? "uncertain"
              : "unavailable";
        record.detail = "detail" in receipt ? receipt.detail?.slice(0, 512) : undefined;
      } catch (error) {
        record.state = began ? "uncertain" : "unavailable";
        record.detail = String(error).slice(0, 512);
      } finally {
        record.version++;
        this.authorities.delete(record.messageId);
        this.save();
        this.settled?.(record);
      }
    })();
    this.active.add(run);
    try {
      await run;
    } finally {
      this.active.delete(run);
    }
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.records));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.active);
  }
}
