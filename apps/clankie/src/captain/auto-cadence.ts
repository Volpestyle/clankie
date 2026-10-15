import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AutoRound } from "@clankie/protocol/auto-rounds";

const LastRoundSchema = z.object({ fingerprint: z.string(), at: z.number().finite().nonnegative() }).strict();
const LeadSchema = z
  .object({
    accepted: LastRoundSchema.optional(),
    pending: LastRoundSchema.extend({ roundId: z.string() }).optional(),
  })
  .strict();
const CadenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    nextTickAt: z.number().finite().nonnegative(),
    leads: z.record(z.string(), LeadSchema),
  })
  .strict();
type Cadence = z.infer<typeof CadenceSchema>;

/**
 * The Auto timer and per-lead idle/delivery fences survive runtime replacement (VUH-2312).
 * The service's BodyLeaseStore process lock excludes simultaneous runtime writers.
 */
export class AutoRoundCadence {
  private readonly path: string;
  constructor(
    directory: string,
    private readonly intervalMs: number,
    private readonly history: () => readonly AutoRound[],
  ) {
    this.path = join(directory, "cadence.json");
  }

  last(conversationId: string): z.infer<typeof LastRoundSchema> | undefined {
    const lead = this.read().leads[conversationId];
    return lead?.pending ?? lead?.accepted;
  }

  retain(conversations: ReadonlySet<string>): void {
    const state = this.read();
    for (const id of Object.keys(state.leads)) if (!conversations.has(id)) delete state.leads[id];
    this.write(state);
  }

  /** Synchronous durable reservation, before any asynchronous wake preparation or send. */
  claim(conversationId: string, roundId: string, fingerprint: string, now = Date.now()): void {
    const state = this.read();
    state.leads[conversationId] = {
      ...state.leads[conversationId],
      pending: { roundId, fingerprint, at: now },
    };
    this.write(state);
  }

  /** Reread and fence by the original round: an old runtime cannot settle a newer claim. */
  settled(conversationId: string, roundId: string, delivered: boolean, now = Date.now()): void {
    const state = this.read();
    const lead = state.leads[conversationId];
    if (lead?.pending?.roundId !== roundId) return;
    if (delivered) lead.accepted = { fingerprint: lead.pending.fingerprint, at: now };
    delete lead.pending;
    this.write(state);
  }

  start(round: () => Promise<void>): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (retryDelay = 0) => {
      if (stopped) return;
      let delay = this.intervalMs;
      try {
        delay = Math.max(retryDelay, this.read().nextTickAt - Date.now());
      } catch (error) {
        console.warn("Auto cadence unavailable", String(error));
      }
      timer = setTimeout(() => void tick(), delay);
      timer.unref();
    };
    const tick = async () => {
      if (stopped) return;
      let retryDelay = 0;
      try {
        const state = this.read();
        const now = Date.now();
        if (state.nextTickAt > now) return;
        // Coalesce missed slots into one check; reserve the next before doing any work.
        state.nextTickAt = now + this.intervalMs;
        this.write(state);
        await round();
      } catch (error) {
        console.warn("Auto round unavailable", String(error));
        retryDelay = Math.min(this.intervalMs, 5_000);
      } finally {
        arm(retryDelay);
      }
    };
    try {
      const state = this.read();
      const rounds = new Map(this.history().map((entry) => [entry.roundId, entry]));
      for (const lead of Object.values(state.leads)) {
        if (!lead.pending) continue;
        const delivery = rounds.get(lead.pending.roundId)?.delivery;
        if (!delivery) continue; // Unknown acceptance stays fenced for the normal idle window.
        if (delivery.delivered)
          lead.accepted = { fingerprint: lead.pending.fingerprint, at: Date.parse(delivery.at) };
        delete lead.pending;
      }
      this.write(state);
    } catch (error) {
      console.warn("Auto cadence recovery unavailable", String(error));
    }
    arm();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  private read(): Cadence {
    try {
      return CadenceSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Upgrade from the existing round record; a new install saves its first deadline too.
      const latest = this.history()[0];
      const at = latest === undefined ? Date.now() : Date.parse(latest.at);
      const state: Cadence = { schemaVersion: 1, nextTickAt: at + this.intervalMs, leads: {} };
      this.write(state);
      return state;
    }
  }

  private write(state: Cadence): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
