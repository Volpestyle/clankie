import type { CheckoutStatus } from "@clankie/protocol";
import { inspectCheckout, ownerCheckout } from "@clankie/settings";

/** Opted-in reads share the complete Git observation, including owner discovery. */
export class CheckoutObservationCache {
  private readonly entries = new Map<
    string,
    { expires: number; pending: Promise<CheckoutStatus | undefined> }
  >();

  constructor(
    private readonly capacity = 128,
    private readonly ttlMs = 30_000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || ttlMs < 1)
      throw Error("Invalid checkout observation cache bounds");
  }

  observe(path: string): Promise<CheckoutStatus | undefined> {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    const cached = this.entries.get(path);
    if (cached) return cached.pending;
    while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const pending = ownerCheckout(path)
      .then(inspectCheckout)
      .catch(() => undefined);
    this.entries.set(path, { expires: now + this.ttlMs, pending });
    return pending;
  }
}
