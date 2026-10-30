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
  public inbox(after = 0, limit = 50): { items: OperatorLeadHeldItem[]; next: number; more: boolean } {
    const newer = this.held.items.filter((item) => item.seq > after);
    const items = newer.slice(0, limit);
    return { items, next: items.at(-1)?.seq ?? after, more: newer.length > items.length };
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
      if (existsSync(this.heldPath))
        return PersistedHeldSchema.parse(JSON.parse(readFileSync(this.heldPath, "utf8")));
    } catch {
      // A damaged list of held turns starts over; the setting itself is kept apart.
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
