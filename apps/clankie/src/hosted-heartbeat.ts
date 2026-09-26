import { z } from "zod";
import { OperatorConversationServiceRequestSchema } from "@clankie/protocol";
import type { HostedBodyClient } from "./hosted-body.ts";

export type HostedBusyReason = "captain-turn" | "herdr-agent" | "scheduled-job";
const REASONS: readonly HostedBusyReason[] = ["captain-turn", "herdr-agent", "scheduled-job"];
const DesiredSchema = z.object({ desired: z.enum(["running", "sleeping", "suspended"]) }).strict();
const WORK_OPS = new Set([
  "create",
  "fork",
  "reset",
  "close",
  "send",
  "cancel",
  "channel",
  "update_persona",
  "react",
  "close_seat",
  "spawn_seat",
  "move_seat",
  "terminal_control",
  "terminal_input",
  "publish_file",
]);

/** Called only after successful authorization/dispatch inside the encrypted boundary. */
export function isHostedCustomerWork(method: string, path: string, body: string): boolean {
  if (method !== "POST") return false;
  if (path === "/v1/pairing/redeem" || path === "/v1/pairing/complete") return true;
  if (path !== "/operator/v1/dispatch") return false;
  try {
    const request = OperatorConversationServiceRequestSchema.parse(JSON.parse(body));
    if (request.op === "autonomy") return request.command.action !== "status";
    if (request.op === "connections") return request.command.action !== "list";
    return WORK_OPS.has(request.op);
  } catch {
    return false;
  }
}

/** Emits transitions immediately and renews busy leases every minute (idle every five). */
export class HostedHeartbeat {
  private readonly counts = new Map<HostedBusyReason, number>();
  private readonly external = new Set<HostedBusyReason>();
  private lastInteractiveAtMs: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;
  private dirty = false;
  private closed = false;
  private started = false;
  private readonly client: Pick<HostedBodyClient, "post">;
  private readonly clock: () => number;
  private readonly onDesired: ((desired: "running" | "sleeping" | "suspended") => void) | undefined;
  private readonly onReport:
    | ((
        report: ReturnType<HostedHeartbeat["snapshot"]> & { desired: "running" | "sleeping" | "suspended" },
      ) => void)
    | undefined;
  private readonly onError: (() => void) | undefined;
  constructor(
    client: Pick<HostedBodyClient, "post">,
    options: {
      clock?: () => number;
      onDesired?: (desired: "running" | "sleeping" | "suspended") => void;
      onError?: () => void;
      onReport?: (
        report: ReturnType<HostedHeartbeat["snapshot"]> & { desired: "running" | "sleeping" | "suspended" },
      ) => void;
    } = {},
  ) {
    this.client = client;
    this.clock = options.clock ?? Date.now;
    this.onDesired = options.onDesired;
    this.onError = options.onError;
    this.onReport = options.onReport;
  }
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.changed();
  }
  /** Reference counts preserve busy until the last overlapping run settles. */
  begin(reason: HostedBusyReason): () => void {
    const previous = this.counts.get(reason) ?? 0;
    this.counts.set(reason, previous + 1);
    if (previous === 0) this.changed();
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      const count = (this.counts.get(reason) ?? 1) - 1;
      this.counts.set(reason, count);
      if (count === 0) this.changed();
    };
  }
  /** Runtime observations are separate from in-process counters. */
  setExternal(reason: HostedBusyReason, busy: boolean): void {
    if (busy === this.external.has(reason)) return;
    if (busy) this.external.add(reason);
    else this.external.delete(reason);
    this.changed();
  }
  interactive(): void {
    this.lastInteractiveAtMs = this.clock();
    this.changed();
  }
  snapshot() {
    const reasons = REASONS.filter(
      (reason) => (this.counts.get(reason) ?? 0) > 0 || this.external.has(reason),
    );
    return {
      busy: reasons.length > 0,
      reasons,
      ...(this.lastInteractiveAtMs === undefined ? {} : { lastInteractiveAtMs: this.lastInteractiveAtMs }),
    };
  }
  private changed(): void {
    if (!this.started || this.closed) return;
    this.dirty = true;
    if (this.sending !== undefined) return;
    this.sending = this.flush().finally(() => {
      this.sending = undefined;
      if (this.dirty && !this.closed) this.changed();
    });
  }
  private async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    let failed = false;
    do {
      this.dirty = false;
      try {
        const report = this.snapshot();
        const response = await this.client.post("heartbeat", report);
        const { desired } = DesiredSchema.parse(await response.json());
        if (!this.closed) {
          this.onReport?.({ ...report, desired });
          this.onDesired?.(desired);
        }
      } catch {
        failed = true;
        this.onError?.();
      }
    } while (this.dirty && !failed && !this.closed);
    if (failed) this.dirty = false;
    if (!this.closed) {
      this.timer = setTimeout(() => this.changed(), failed || this.snapshot().busy ? 60_000 : 300_000);
      this.timer.unref();
    }
  }
  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
