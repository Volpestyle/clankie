import { BodyResourceSchema, type BodyResource } from "@clankie/protocol";
import type { BodyLeaseStore } from "./body-leases.ts";
import type { BodyLeaseRouter } from "./body-lease-router.ts";

/** Boot sweep and capped retries; expiry alone never proves a body is stopped. */
export class BodyLeaseRecovery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private readonly retries = new Map<BodyResource, { token: string; delayMs: number; at: number }>();
  private readonly options: {
    store: BodyLeaseStore;
    router: BodyLeaseRouter;
    holderTurnEnded: (conversationId: string) => boolean;
    confirmStopped: (resource: BodyResource, guard: () => Promise<void>) => Promise<boolean>;
    current: () => boolean;
    onError?: (error: unknown) => void;
    /** Short real intervals for isolated integration fixtures; production defaults to 5s–60s. */
    retryMs?: number;
    maxRetryMs?: number;
  };
  constructor(options: BodyLeaseRecovery["options"]) {
    this.options = options;
  }
  start(): void {
    if (!this.closed && !this.timer && !this.running) this.schedule(0);
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** Shutdown may wait for the original check without restarting it or dropping its lease. */
  async settled(): Promise<void> {
    await this.running;
  }
  private schedule(delayMs: number): void {
    if (this.closed || !this.options.current()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.sweep()
        .catch((error: unknown) => this.options.onError?.(error))
        .finally(() => {
          this.running = undefined;
          this.schedule(this.options.retryMs ?? 5000);
        });
    }, delayMs);
    this.timer.unref();
  }
  private async sweep(): Promise<void> {
    const initial = this.options.retryMs ?? 5000;
    const maximum = this.options.maxRetryMs ?? 60_000;
    for (const resource of BodyResourceSchema.options) {
      // Computer sessions own their separate verified adapter stop/recovery contract.
      if (resource === "computer" || this.closed || !this.options.current()) continue;
      const lease = this.options.store.status(resource);
      const ref = this.options.store.recoveryReference(resource);
      if (lease?.state !== "recovery_required" || !ref) {
        this.retries.delete(resource);
        continue;
      }
      const retry = this.retries.get(resource);
      if (retry?.token === ref.token && retry.at > Date.now()) continue;
      if (!this.options.store.recoveryReady(ref) || !this.options.holderTurnEnded(ref.conversationId))
        continue;
      const delayMs = retry?.token === ref.token ? Math.min(maximum, retry.delayMs * 2) : initial;
      try {
        const result = await this.options.router.recoverIdle(
          resource,
          this.options.holderTurnEnded,
          (guard) => this.options.confirmStopped(resource, guard),
          () => !this.closed && this.options.current(),
        );
        if (result.outcome === "released") {
          this.retries.delete(resource);
          continue;
        }
      } catch (error) {
        this.options.onError?.(error);
      }
      this.retries.set(resource, { token: ref.token, delayMs, at: Date.now() + delayMs });
    }
  }
}
