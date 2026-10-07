import type { FleetSeatToolCatalog, FleetSeatToolCatalogHealth } from "@clankie/protocol/tool-catalog";

export interface ToolCatalogIdentity {
  readonly paneId: string;
  readonly occupantId: string;
  readonly harness: "claude" | "codex";
  readonly sessionId?: string;
  readonly bridge: "worker" | "operator";
}

function remediation(identity: ToolCatalogIdentity, observed: boolean): string {
  return identity.harness === "claude"
    ? observed
      ? "Run /reload-plugins in this Claude Code pane to reload Clankie's bridge and recheck its tools."
      : "Restart this Claude Code pane with its current Clankie plugin and resume the same session to recheck its tools."
    : "Advisory only: continue with your current lead and use the tools this pane exposes. If a required tool is unavailable, report that specific blocker to your lead; catalog verification does not require a new hire.";
}

/** Reports belong to native occupants, never the reusable pane address. */
export class ToolCatalogHealthStore {
  private readonly reports = new Map<
    string,
    { identity: ToolCatalogIdentity; report: FleetSeatToolCatalog; expected: readonly string[] }
  >();

  record(
    identity: ToolCatalogIdentity,
    report: FleetSeatToolCatalog,
    expected: readonly string[],
  ): FleetSeatToolCatalogHealth {
    this.reports.set(this.key(identity), { identity, report, expected });
    return this.read(identity);
  }

  read(identity: ToolCatalogIdentity, expected?: readonly string[]): FleetSeatToolCatalogHealth {
    const entry = this.reports.get(this.key(identity));
    const report =
      entry?.identity.occupantId === identity.occupantId &&
      entry.identity.harness === identity.harness &&
      entry.identity.bridge === identity.bridge &&
      entry.report.sessionId === identity.sessionId
        ? entry.report
        : undefined;
    const evidence = {
      harness: identity.harness,
      ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
      bridge: identity.bridge,
      ...(report === undefined ? {} : { checkedAt: report.checkedAt }),
    };
    if (!report || report.error)
      return {
        ...evidence,
        status: "unverified",
        missing: [],
        detail:
          report?.error ?? "This native session has not reported which Clankie tools its client accepted.",
        remediation: remediation(identity, report !== undefined),
      };
    const current = expected ?? entry!.expected;
    const missing = current.filter((name) => !report.tools.includes(name));
    const unexpected = report.tools.filter((name) => !current.includes(name));
    const mismatch = missing.length > 0 || unexpected.length > 0;
    return {
      ...evidence,
      status: mismatch ? "mismatch" : "matched",
      missing,
      detail: mismatch
        ? [
            `Native ${identity.harness} client catalog differs from this Clankie bridge.`,
            ...(missing.length ? [`Missing: ${missing.join(", ")}`] : []),
            ...(unexpected.length ? [`No longer served: ${unexpected.join(", ")}`] : []),
          ]
            .join(" ")
            .slice(0, 4096)
        : "The native client lists every tool served by this Clankie bridge.",
      ...(mismatch ? { remediation: remediation(identity, true) } : {}),
    };
  }

  /** A bad second bridge must stay visible when the other bridge is healthy. */
  readPane(
    identity: ToolCatalogIdentity,
    expected?: { worker?: readonly string[]; operator?: readonly string[] },
  ): FleetSeatToolCatalogHealth {
    const other: ToolCatalogIdentity = {
      ...identity,
      bridge: identity.bridge === "worker" ? "operator" : "worker",
    };
    const entry = this.reports.get(this.key(other));
    const health = this.read(identity, expected?.[identity.bridge]);
    if (
      !entry ||
      entry.identity.occupantId !== identity.occupantId ||
      entry.identity.harness !== identity.harness ||
      entry.report.sessionId !== identity.sessionId
    )
      return health;
    const secondary = this.read(other, expected?.[other.bridge]);
    const priority = { matched: 0, unverified: 1, mismatch: 2 };
    return priority[secondary.status] > priority[health.status] ? secondary : health;
  }

  conversationId(identity: ToolCatalogIdentity): string | undefined {
    const entry = this.reports.get(this.key(identity));
    return entry?.identity.occupantId === identity.occupantId &&
      entry.identity.harness === identity.harness &&
      entry.report.sessionId === identity.sessionId
      ? entry.report.conversationId
      : undefined;
  }

  hasReport(identity: ToolCatalogIdentity): boolean {
    const entry = this.reports.get(this.key(identity));
    return (
      entry?.identity.occupantId === identity.occupantId &&
      entry.identity.harness === identity.harness &&
      entry.report.sessionId === identity.sessionId
    );
  }

  private key(identity: ToolCatalogIdentity): string {
    return `${identity.paneId}/${identity.bridge}`;
  }
}
