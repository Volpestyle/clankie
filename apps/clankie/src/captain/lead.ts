import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  OPERATOR_LEAD_HELD_TEXT_MAX,
  OperatorLeadHeldItemSchema,
  OperatorLeadSchema,
  type OperatorConversation,
  type OperatorLead,
  type OperatorLeadHeldItem,
  type OperatorLeadStatus,
} from "@clankie/protocol";
import { z } from "zod";

/** Held turns kept for the connected apps; the oldest go first. */
const HELD_MAX = 500;

const PersistedLeadSchema = z.object({ schemaVersion: z.literal(1), lead: OperatorLeadSchema }).strict();
const PersistedHeldSchema = z
  .object({
    schemaVersion: z.literal(1),
    nextSeq: z.number().int().positive(),
    items: z.array(OperatorLeadHeldItemSchema).max(HELD_MAX),
  })
  .strict();

/**
 * Who leads Clankie's lead threads (ADR 0304). While connected apps lead, a turn
 * Clankie would have taken himself (a worker's message, a wake, a watch) is held
 * here for them instead of running his model. A missing file reads as Clankie;
 * an unreadable one reads as apps, so a damaged setting never restarts his turns.
 */
export class LeadStore {
  private lead: OperatorLead;
  private unreadable = false;
  private heldUnreadable = false;
  private held: z.infer<typeof PersistedHeldSchema>;
  private readonly path: string;
  private readonly heldPath: string;
  private readonly onChange: () => void;

  public constructor(path: string, heldPath: string, onChange: () => void = () => {}) {
    this.path = path;
    this.heldPath = heldPath;
    this.onChange = onChange;
    this.lead = this.readLead();
    this.held = this.readHeld();
  }

  public status(): OperatorLeadStatus {
    return {
      lead: this.lead,
      ...(this.unreadable ? { error: "state_unreadable" as const } : {}),
      held: this.held.items.length,
    };
  }

  public set(lead: OperatorLead): OperatorLeadStatus {
    this.lead = lead;
    this.save(this.path, { schemaVersion: 1, lead });
    this.unreadable = false;
    this.onChange();
    return this.status();
  }

  /** Only Clankie's own lead threads are handed over; rooms, channels and personas never are. */
  public holds(scope: OperatorConversation["scope"] | undefined): boolean {
    return this.lead === "apps" && (scope?.kind === "global" || scope?.kind === "workspace");
  }

  /**
   * Whether the switch holds this turn (ADR 0350). While off, a turn runs only
   * when the owner verifiably sent it: published input (not `internal`) whose
   * owner proof is still current, either question authority (the operator or a
   * Take Control device, including his answers) or a host-verified sender such
   * as his Supervise phone or a guarded linked channel. Everything else is held:
   * his own wakes and watches, notices that carry owner authority but are not
   * the owner's words, and sends with no owner proof, such as a bare captain
   * bearer. Whether off should also stop the owner's own messages is the
   * `ownerSent` condition alone.
   */
  public holdsTurn(
    scope: OperatorConversation["scope"] | undefined,
    turn: {
      readonly internal?: true;
      readonly ownerAuthority?: { readonly current: () => boolean };
      readonly leadOwner?: { readonly current: () => boolean };
    },
  ): boolean {
    if (!this.holds(scope)) return false;
    const ownerSent =
      turn.internal !== true &&
      (turn.ownerAuthority?.current() === true || turn.leadOwner?.current() === true);
    return !ownerSent;
  }

  public hold(item: Omit<OperatorLeadHeldItem, "seq" | "at">, at = new Date().toISOString()): void {
    const held: OperatorLeadHeldItem = {
      ...item,
      seq: this.held.nextSeq,
      at,
      text: item.text.slice(0, OPERATOR_LEAD_HELD_TEXT_MAX),
    };
    this.held = {
      schemaVersion: 1,
      nextSeq: held.seq + 1,
      items: [...this.held.items, held].slice(-HELD_MAX),
    };
    this.save(this.heldPath, this.held);
    this.onChange();
  }

  /** Held items after `after`, oldest first; `next` is the `after` that reads on from here. */
  public inbox(
    after = 0,
    limit = 50,
  ): { items: OperatorLeadHeldItem[]; next: number; more: boolean; error?: "state_unreadable" } {
    const newer = this.held.items.filter((item) => item.seq > after);
    const items = newer.slice(0, limit);
    return {
      items,
      next: items.at(-1)?.seq ?? after,
      more: newer.length > items.length,
      ...(this.heldUnreadable ? { error: "state_unreadable" as const } : {}),
    };
  }

  private readLead(): OperatorLead {
    if (!existsSync(this.path)) return "clankie";
    try {
      return PersistedLeadSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))).lead;
    } catch {
      this.unreadable = true;
      return "apps";
    }
  }

  private readHeld(): z.infer<typeof PersistedHeldSchema> {
    try {
      return PersistedHeldSchema.parse(JSON.parse(readFileSync(this.heldPath, "utf8")));
    } catch (error) {
      // Missing state is a new inbox; unreadable state is not evidence of an empty inbox.
      this.heldUnreadable = !(error instanceof Error && "code" in error && error.code === "ENOENT");
    }
    return { schemaVersion: 1, nextSeq: 1, items: [] };
  }

  private save(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
