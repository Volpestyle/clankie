import { randomUUID } from "node:crypto";
import type { ControlLease } from "@clankie/terminal-protocol";

export class ControlLeaseManager {
  private readonly byTerminal = new Map<string, ControlLease>();

  public acquire(terminalId: string, principalId: string, durationMs = 60_000): ControlLease {
    this.expireStale();
    const existing = this.byTerminal.get(terminalId);
    if (existing && existing.principalId !== principalId) {
      throw new Error(`Terminal ${terminalId} is controlled by ${existing.principalId}`);
    }
    const now = Date.now();
    const lease: ControlLease = {
      id: existing?.id ?? randomUUID(),
      terminalId,
      principalId,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + durationMs).toISOString(),
      mode: "control",
    };
    this.byTerminal.set(terminalId, lease);
    return lease;
  }

  public renew(terminalId: string, leaseId: string, durationMs = 60_000): ControlLease {
    const lease = this.assert(terminalId, leaseId);
    lease.expiresAt = new Date(Date.now() + durationMs).toISOString();
    this.byTerminal.set(terminalId, lease);
    return structuredClone(lease);
  }

  public revoke(terminalId: string): void {
    this.byTerminal.delete(terminalId);
  }

  public assert(terminalId: string, leaseId: string): ControlLease {
    this.expireStale();
    const lease = this.byTerminal.get(terminalId);
    if (!lease || lease.id !== leaseId || lease.mode !== "control")
      throw new Error("A valid control lease is required");
    return lease;
  }

  public release(terminalId: string, leaseId: string): void {
    this.assert(terminalId, leaseId);
    this.byTerminal.delete(terminalId);
  }

  public active(terminalId: string): ControlLease | undefined {
    this.expireStale();
    const lease = this.byTerminal.get(terminalId);
    return lease ? structuredClone(lease) : undefined;
  }

  public expireStale(now = Date.now()): void {
    for (const [terminalId, lease] of this.byTerminal) {
      if (Date.parse(lease.expiresAt) <= now) this.byTerminal.delete(terminalId);
    }
  }
}
