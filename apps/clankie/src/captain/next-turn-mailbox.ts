import type { ProjectProcessProof } from "../project-process-proof.ts";
import { randomUUID, createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FleetSeatDelivery } from "./fleet-seat.ts";

const TTL_MS = 24 * 60 * 60 * 1000;
interface Mail {
  id: string;
  fingerprint: string;
  text: string;
  expiresAt: number;
  taken: boolean;
  delivered?: boolean;
}
interface Inbox {
  binding: string;
  receiver: string;
  expiresAt: number;
  mail: Mail[];
}

/** The HTTP layer supplies this proof from socket ancestry, never the hook payload. */
export function nextTurnReceiverProof(
  proof: (ProjectProcessProof & { readonly nativeSessionPending?: true }) | undefined,
  expected: { fleet: string; pane: string; nativeOccupantId: string },
): string | undefined {
  return proof &&
    !proof.nativeSessionPending &&
    proof.fleet === expected.fleet &&
    proof.pane === expected.pane &&
    proof.nativeOccupantId === expected.nativeOccupantId
    ? createHash("sha256").update(JSON.stringify(proof)).digest("hex")
    : undefined;
}

/** A hook take is destructive before HTTP response: an uncertain response is never replayed. */
export class NextTurnMailbox {
  private inboxes: Record<string, Inbox> = {};
  private readonly path: string;
  private readonly now: () => number;
  constructor(path: string, now = Date.now) {
    this.path = path;
    this.now = now;
    try {
      this.inboxes = JSON.parse(readFileSync(path, "utf8")) as Record<string, Inbox>;
    } catch {
      // Missing/corrupt state cannot manufacture a plugin observation or replay mail.
    }
  }

  observe(seat: string, binding: string, receiver = binding): void {
    const old = this.inboxes[seat];
    this.inboxes[seat] = {
      binding,
      receiver,
      expiresAt: this.now() + TTL_MS,
      mail:
        old?.binding === binding && old.receiver === receiver
          ? old.mail.filter((mail) => mail.expiresAt > this.now())
          : [],
    };
    this.save();
  }

  /** Check before selecting another channel: an old handoff cannot be replayed live. */
  receipt(seat: string, binding: string | undefined, text: string): FleetSeatDelivery | undefined {
    const inbox = this.inboxes[seat];
    const fingerprint = createHash("sha256").update(text).digest("hex");
    if (
      !binding ||
      inbox?.binding !== binding ||
      inbox.expiresAt <= this.now() ||
      !inbox.mail.some((mail) => mail.fingerprint === fingerprint && mail.expiresAt > this.now())
    )
      return undefined;
    return this.store(seat, binding, text);
  }

  store(seat: string, binding: string | undefined, text: string): FleetSeatDelivery {
    const inbox = this.inboxes[seat];
    if (!binding || inbox?.binding !== binding || inbox.expiresAt <= this.now())
      return {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: "No observed worker hook for this native session; no terminal input was sent.",
      };
    inbox.mail = inbox.mail.filter((mail) => mail.expiresAt > this.now());
    const fingerprint = createHash("sha256").update(text).digest("hex");
    const existing = inbox.mail.find((mail) => mail.fingerprint === fingerprint);
    if (existing?.delivered)
      return {
        outcome: "delivered",
        deliveryStage: "delivered",
        messageId: existing.id,
        detail:
          "The hook confirmed writing this reply to its native output pipe; model consumption is not confirmed.",
      };
    if (existing?.taken)
      return {
        outcome: "unconfirmed",
        deliveryStage: "uncertain",
        messageId: existing.id,
        detail:
          "This reply was handed to the next-turn hook; its consumption is unconfirmed. It will not be replayed.",
      };
    if (!existing && inbox.mail.length >= 100)
      return {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: "The next-turn mailbox is full.",
      };
    const mail = existing ?? {
      id: randomUUID(),
      fingerprint,
      text,
      expiresAt: this.now() + TTL_MS,
      taken: false,
    };
    if (!existing) inbox.mail.push(mail);
    this.save();
    return {
      outcome: "delivered",
      deliveryStage: "stored",
      messageId: mail.id,
      detail:
        "Stored for this session's next UserPromptSubmit hook; expires within 24 hours. Harness consumption is not confirmed.",
    };
  }

  take(seat: string, binding: string): { additionalContext: string; messageIds: string[] } | undefined {
    const inbox = this.inboxes[seat];
    if (inbox?.binding !== binding || inbox.expiresAt <= this.now()) return undefined;
    const pending = inbox.mail.filter((mail) => !mail.taken && mail.expiresAt > this.now());
    if (!pending.length) return undefined;
    for (const mail of pending) mail.taken = true;
    this.save();
    return {
      additionalContext: pending
        .map((mail) => `Message from Clankie (${mail.id}):\n${mail.text}`)
        .join("\n\n"),
      messageIds: pending.map((mail) => mail.id),
    };
  }

  acknowledge(seat: string, binding: string, ids: readonly string[]): void {
    const inbox = this.inboxes[seat];
    if (inbox?.binding !== binding || inbox.expiresAt <= this.now()) return;
    for (const mail of inbox.mail) {
      if (mail.taken && mail.expiresAt > this.now() && ids.includes(mail.id)) mail.delivered = true;
    }
    this.save();
  }

  private save(): void {
    for (const [seat, inbox] of Object.entries(this.inboxes))
      if (inbox.expiresAt <= this.now()) delete this.inboxes[seat];
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const file = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(file, JSON.stringify(this.inboxes));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
