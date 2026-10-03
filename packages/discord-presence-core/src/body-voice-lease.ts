import { randomUUID } from "node:crypto";
import type {
  BodyLeaseResult,
  BodyVoiceLeaseRequest,
  BodyVoiceStay,
  BodyVoiceTarget,
} from "@clankie/protocol";

export class VoiceBodyLeaseDenied extends Error {
  public readonly bodyLease: BodyLeaseResult;
  public constructor(result: BodyLeaseResult) {
    super("Voice body lease denied");
    this.bodyLease = result;
  }
}
export interface VoiceBodyAdmission {
  readonly stay: BodyVoiceStay;
  readonly guard: () => Promise<void>;
  readonly current: () => boolean;
  readonly start?: () => void;
}
interface Active {
  readonly admission: VoiceBodyAdmission;
  readonly incarnation: string;
  expiresAt: number;
  lost: boolean;
  started: boolean;
  readonly authorized: () => boolean;
  timer?: ReturnType<typeof setTimeout>;
}
/** Body-owned adapter: uncertain loss stops local effects but never invents a leave receipt. */
export class VoiceBodyLease {
  private readonly rpc: (request: BodyVoiceLeaseRequest) => Promise<BodyLeaseResult>;
  private readonly onLost: (stay: BodyVoiceStay) => Promise<void>;
  private readonly clock: () => number;
  private generation = 0;
  private readonly kind: "audio" | "publish";
  private readonly active = new Map<string, Active>();
  public constructor(options: {
    rpc(request: BodyVoiceLeaseRequest): Promise<BodyLeaseResult>;
    onLost(stay: BodyVoiceStay): Promise<void>;
    clock?: () => number;
    kind?: "audio" | "publish";
  }) {
    this.rpc = options.rpc;
    this.onLost = options.onLost;
    this.clock = options.clock ?? Date.now;
    this.kind = options.kind ?? "audio";
  }

  public async admit(
    target: BodyVoiceTarget,
    ticket?: string,
    authorized: () => boolean = () => true,
  ): Promise<VoiceBodyAdmission> {
    if (!authorized()) throw new VoiceBodyLeaseDenied({ outcome: "rejected", reason: "not_authorized" });
    const stay: BodyVoiceStay = {
      stayId: randomUUID(),
      generation: ++this.generation,
      target,
      kind: this.kind,
    };
    const result = await this.rpc({ action: "claim", stay, ...(ticket === undefined ? {} : { ticket }) });
    if (result.outcome !== "acquired") throw new VoiceBodyLeaseDenied(result);
    const admission: VoiceBodyAdmission = {
      stay,
      current: () => {
        const active = this.active.get(stay.stayId);
        return active !== undefined && !active.lost && active.authorized() && active.expiresAt > this.clock();
      },
      guard: () => this.heartbeat(stay.stayId),
      start: () => {
        const active = this.active.get(stay.stayId);
        if (active === undefined || !admission.current())
          throw new VoiceBodyLeaseDenied({ outcome: "rejected", reason: "stale_lease" });
        active.started = true;
      },
    };
    this.active.set(stay.stayId, {
      admission,
      incarnation: result.incarnation,
      expiresAt: result.lease.expiresAt,
      lost: false,
      started: false,
      authorized,
    });
    this.schedule(stay.stayId);
    return admission;
  }
  private schedule(stayId: string): void {
    const active = this.active.get(stayId);
    if (active === undefined || active.lost) return;
    active.timer = setTimeout(() => {
      void this.heartbeat(stayId).then(
        () => this.schedule(stayId),
        () => undefined,
      );
    }, 5_000);
    active.timer.unref?.();
  }
  private async heartbeat(stayId: string): Promise<void> {
    const active = this.active.get(stayId);
    if (active === undefined || active.lost || !active.authorized() || active.expiresAt <= this.clock()) {
      if (active !== undefined) this.lose(active);
      throw new VoiceBodyLeaseDenied({ outcome: "rejected", reason: "stale_lease" });
    }
    try {
      const result = await this.rpc({
        action: "heartbeat",
        stay: active.admission.stay,
        incarnation: active.incarnation,
      });
      if (this.active.get(stayId) !== active || active.lost || !active.authorized())
        throw new Error("Voice stay changed");
      if (result.outcome !== "renewed") throw new VoiceBodyLeaseDenied(result);
      active.expiresAt = result.lease.expiresAt;
    } catch (error) {
      this.lose(active);
      throw error;
    }
  }
  private lose(active: Active): void {
    if (active.lost) return;
    active.lost = true;
    clearTimeout(active.timer);
    if (active.started) void this.onLost(active.admission.stay).catch(() => undefined);
    else void this.confirmedLeave(active.admission.stay.stayId).catch(() => undefined);
  }
  public admission(stayId: string): VoiceBodyAdmission | undefined {
    return this.active.get(stayId)?.admission;
  }

  /** Host proves the admitted operation never reached its first effect. */
  public async settleUnstarted(stayId: string): Promise<void> {
    const active = this.active.get(stayId);
    if (active !== undefined && !active.started) await this.confirmedLeave(stayId);
  }

  /** Called with the exact core stay ID captured by the gateway's confirmed-leave path. */
  public async confirmedLeave(stayId: string): Promise<void> {
    const active = this.active.get(stayId);
    if (active === undefined) return;
    clearTimeout(active.timer);
    active.lost = true;
    const result = await this.rpc({
      action: "finish",
      stay: active.admission.stay,
      incarnation: active.incarnation,
    });
    if (result.outcome !== "released") throw new VoiceBodyLeaseDenied(result);
    this.active.delete(stayId);
  }
}

/** Service-stamped transport context; never parsed from a model tool argument. */
export type BodyEffectGuard = (() => Promise<void>) & {
  readonly publish?: { readonly ticket?: string; readonly stayId?: string; readonly target: BodyVoiceTarget };
};
