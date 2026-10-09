import type { FleetSeatMessageReceiver, FleetSeatWaitingMessages, OwnerUpdateDraft } from "@clankie/protocol";
import { z } from "zod";
import type { ProjectProcessProof } from "../project-process-proof.ts";
import { randomUUID, createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FleetSeatDelivery } from "./fleet-seat.ts";

const TTL_MS = 24 * 60 * 60 * 1000;
const InboxSchema = z
  .object({
    binding: z.string().min(1),
    receiver: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    mail: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
            text: z.string(),
            expiresAt: z.number().int().nonnegative(),
            taken: z.boolean(),
            delivered: z.boolean().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

type Inbox = z.infer<typeof InboxSchema>;

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
  private unreadable = false;
  private readonly path: string;
  private readonly now: () => number;
  constructor(path: string, now = Date.now) {
    this.path = path;
    this.now = now;
    try {
      this.inboxes = z.record(z.string(), InboxSchema).parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      // Only first-use absence is empty. Lost tombstones must never enable replay.
      this.unreadable = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  /** A host-authenticated hook observed this exact native recipient recently. */
  observed(seat: string, binding: string): boolean {
    const inbox = this.inboxes[seat];
    return !this.unreadable && inbox?.binding === binding && inbox.expiresAt > this.now();
  }

  /** Read-only receiver status; the caller proves live polling for this exact binding. */
  messageReceiver(
    seat: string,
    binding: string | undefined,
    live: boolean,
    sessionId?: string,
  ): FleetSeatMessageReceiver {
    if (binding && live)
      return {
        state: "live",
        detail:
          "A live native event poll is observed for this session. This does not prove model consumption.",
      };
    if (binding && this.observed(seat, binding))
      return {
        state: "next-turn-only",
        detail:
          "Idle wake is unavailable: only this session's next UserPromptSubmit receiver is observed. Messages stay in the next-turn mailbox. Check the channel launch flag and bridge connection; plugin installation alone cannot enable a channel in a running Claude session. Coordinate any reconnect or relaunch with the owner; do not type into the pane or replay mail." +
          (z.string().uuid().safeParse(sessionId).success
            ? ` When authorized, resume in the original cwd and account/config home: claude --resume ${sessionId} --channels plugin:clankie-worker@clankie`
            : ""),
      };
    return {
      state: "unverified",
      detail:
        "No live native poll or recent next-turn receiver is observed for this session. Installed tools and a healthy fleet link do not prove idle wake support.",
    };
  }

  observe(seat: string, binding: string, receiver = binding): void {
    if (this.unreadable) return;
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

  /** Read only metadata for the original occupant, including persisted mail after restart. */
  waiting(seat: string, binding: string | undefined): FleetSeatWaitingMessages | undefined {
    const pending = this.pending(seat, binding);
    if (!pending.length) return undefined;
    return {
      stored: pending.filter((mail) => !mail.taken).length,
      unconfirmed: pending.filter((mail) => mail.taken).length,
      oldestAt: new Date(Math.min(...pending.map((mail) => mail.expiresAt - TTL_MS))).toISOString(),
      expiresAt: new Date(Math.min(...pending.map((mail) => mail.expiresAt))).toISOString(),
      detail:
        "Stored mail waits for this session's next UserPromptSubmit; a taken message awaits its output acknowledgment. Neither proves model consumption. Do not replay uncertain mail.",
    };
  }

  /** Stable, body-free owner notice. The owner mailbox deduplicates across restarts. */
  waitingNotice(
    seat: string,
    binding: string | undefined,
    pane: string,
  ): { publicationId: string; draft: OwnerUpdateDraft } | undefined {
    const first = this.pending(seat, binding).find((mail) => !mail.taken);
    if (!first) return undefined;
    return {
      publicationId: first.id,
      draft: {
        seatId: seat,
        title: `Message waiting in ${pane}`.slice(0, 200),
        body: `A message was stored for ${pane} because live native delivery was unavailable. It waits for that original session's next user prompt and expires within 24 hours. No terminal input was sent. Check the fleet roster for the current queue and handoff state. Enabling Claude's worker channel requires starting Claude with --channels plugin:clankie-worker@clankie; do not restart an existing lane without authority.`,
      },
    };
  }

  private pending(seat: string, binding: string | undefined): Inbox["mail"] {
    const inbox = this.inboxes[seat];
    return !this.unreadable && binding && inbox?.binding === binding && inbox.expiresAt > this.now()
      ? inbox.mail.filter((mail) => !mail.delivered && mail.expiresAt > this.now())
      : [];
  }

  /** Read one exact original acknowledgment without taking, storing or replaying mail. */
  acknowledged(seat: string, binding: string | undefined, id: string, text: string): boolean {
    const inbox = this.inboxes[seat];
    if (this.unreadable || !binding || inbox?.binding !== binding || inbox.expiresAt <= this.now())
      return false;
    const originals = inbox.mail.filter((mail) => mail.id === id);
    return (
      originals.length === 1 &&
      originals[0]!.expiresAt > this.now() &&
      originals[0]!.fingerprint === createHash("sha256").update(text).digest("hex") &&
      originals[0]!.taken &&
      originals[0]!.delivered === true
    );
  }

  /** Check before selecting another channel: an old handoff cannot be replayed live. */
  receipt(seat: string, binding: string | undefined, text: string): FleetSeatDelivery | undefined {
    if (this.unreadable) return this.unreadableReceipt();
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
    if (this.unreadable) return this.unreadableReceipt();
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
    if (this.unreadable) return undefined;
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
    if (this.unreadable) return undefined;
    const inbox = this.inboxes[seat];
    if (inbox?.binding !== binding || inbox.expiresAt <= this.now()) return;
    for (const mail of inbox.mail) {
      if (mail.taken && mail.expiresAt > this.now() && ids.includes(mail.id)) mail.delivered = true;
    }
    this.save();
  }

  private unreadableReceipt(): FleetSeatDelivery {
    return {
      outcome: "unconfirmed",
      deliveryStage: "uncertain",
      detail:
        "Next-turn receipts are unreadable. No message was sent; recover the original journal before retrying.",
    };
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
