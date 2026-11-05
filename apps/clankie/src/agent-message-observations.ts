import type { NativeMessageObservation } from "./agent-message-dispatch.ts";
import { AgentMessageReceipts, type AgentMessageBinding } from "./agent-message-receipts.ts";
import { setTimeout as delay } from "node:timers/promises";

interface Observation {
  readonly receiptId: string;
  readonly binding: AgentMessageBinding;
  readonly native: NativeMessageObservation;
  readonly authorize: () => Promise<void>;
  readonly current: () => boolean;
}

/** Observes an accepted original only. No sends, native attachment, lead wake or model work. */
export class AgentMessageObservations {
  private readonly receipts: AgentMessageReceipts;
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private closed = false;

  public constructor(receipts: AgentMessageReceipts) {
    this.receipts = receipts;
  }

  public start(input: Observation): void {
    if (this.closed || this.active.has(input.receiptId) || !input.current()) return;
    const abort = new AbortController();
    const current = () => {
      try {
        return !this.closed && !abort.signal.aborted && input.current();
      } catch {
        return false;
      }
    };
    // A withdrawn registration or expired original session ends the wait, without
    // stopping the recipient's work or transferring observation to a new sender.
    const timer = setInterval(() => {
      if (!current()) abort.abort();
    }, 1000);
    timer.unref();
    const done = (async () => {
      try {
        while (current()) {
          await input.authorize();
          if (!current()) return;
          const event = await input.native.read(abort.signal);
          await input.authorize();
          if (!current()) return;
          if (event.type === "turn_started" || event.type === "turn_completed") {
            if (event.messageId !== input.native.messageId) return;
            this.receipts.observe(input.receiptId, input.binding, event);
            if (event.type === "turn_completed") return;
          } else if (event.type !== "blocked") return;
          await delay(1000, undefined, { signal: abort.signal });
        }
      } catch {
        // allow-swallowed-rejection -- Missing authority or native proof leaves progress unknown; never replay or persist native diagnostics.
      }
    })().finally(() => {
      clearInterval(timer);
      this.active.delete(input.receiptId);
    });
    this.active.set(input.receiptId, { abort, done });
  }

  public async close(): Promise<void> {
    this.closed = true;
    const active = [...this.active.values()];
    for (const observation of active) observation.abort.abort();
    await Promise.allSettled(active.map((observation) => observation.done));
  }
}
