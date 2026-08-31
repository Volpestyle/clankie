import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  OperatorTerminalControlOwner,
  OperatorTerminalControlRequest,
  OperatorTerminalControlResult,
  OperatorTerminalInputRequest,
  OperatorTerminalInputResult,
} from "@clankie/protocol";
import { readTerminalGrid, type HerdrPaneGrid } from "./herdr-census.ts";

const DEFAULT_LEASE_TTL_MS = 45_000;
const DEFAULT_MAX_CONTROLLERS = 16;

export interface HerdrTerminalController {
  /** Write one NDJSON command line; false once the controller's stdin is gone. */
  write(line: string): boolean;
  readonly done: Promise<void>;
  close(): void;
}

export type StartHerdrTerminalController = (
  terminalId: string,
  grid: HerdrPaneGrid | undefined,
) => HerdrTerminalController;

export type ReadHerdrTerminalGrid = (terminalId: string) => Promise<HerdrPaneGrid | undefined>;

/** Structured sink for one control action and its outcome. */
export type HerdrTerminalControlLog = (fields: Readonly<Record<string, unknown>>) => void;

/**
 * Exclusive, renewable input leases over Herdr's terminal control sessions
 * (ADR 0144). One lease per terminal; the holder rides raw VT bytes through a
 * `herdr terminal session control` subprocess. Herdr applies the bytes; this
 * store only arbitrates who may send them and for how long.
 */
export class HerdrTerminalControlStore {
  private readonly leases = new Map<string, TerminalLease>();
  private readonly log: HerdrTerminalControlLog;
  private readonly startController: StartHerdrTerminalController;
  private readonly readGrid: ReadHerdrTerminalGrid;
  private readonly leaseTtlMs: number;
  private readonly maxControllers: number;
  private readonly clock: () => number;

  public constructor(
    options: {
      readonly log?: HerdrTerminalControlLog;
      readonly startController?: StartHerdrTerminalController;
      readonly readGrid?: ReadHerdrTerminalGrid;
      readonly leaseTtlMs?: number;
      readonly maxControllers?: number;
      readonly clock?: () => number;
    } = {},
  ) {
    // Default to the service log stream: these lines are the only record of
    // which control action a surface sent and what it got back.
    this.log = options.log ?? ((fields) => console.info(JSON.stringify({ service: "clankie", ...fields })));
    this.startController = options.startController ?? startHerdrTerminalController;
    this.readGrid = options.readGrid ?? ((terminalId) => readTerminalGrid(terminalId));
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.maxControllers = options.maxControllers ?? DEFAULT_MAX_CONTROLLERS;
    this.clock = options.clock ?? Date.now;
  }

  public async control(request: OperatorTerminalControlRequest): Promise<OperatorTerminalControlResult> {
    const result = await this.controlAction(request);
    // Only op names reach the relay log, so without this the action mix and its
    // outcome are invisible while debugging a surface that "does nothing".
    this.log({
      event: "terminal.control",
      terminalId: request.terminalId,
      surfaceClientId: request.surfaceClientId,
      action: request.action,
      status: result.status,
      ...(result.status === "unavailable" || result.status === "denied" ? { reason: result.reason } : {}),
    });
    return result;
  }

  private async controlAction(
    request: OperatorTerminalControlRequest,
  ): Promise<OperatorTerminalControlResult> {
    this.sweep();
    const lease = this.leases.get(request.terminalId);
    switch (request.action) {
      case "request": {
        if (lease !== undefined && lease.owner.principalId !== request.surfaceClientId) {
          return this.contended(request.terminalId, lease);
        }
        // A fresh request from the holder re-mints the token, so a relaunched
        // surface reclaims its own lease instead of waiting out the TTL.
        if (lease !== undefined) return this.grant(request.terminalId, lease);
        if (this.leases.size >= this.maxControllers) {
          return unavailableControl(request.terminalId, "controller_closed");
        }
        // Herdr resizes a pane to its controlling client on attach and then pins
        // it there for the lease. Claiming control at the pane's own grid makes
        // that resize a no-op, so a phone taking the keyboard never reflows the
        // operator's desktop pane out from under them.
        const grid = await this.readGrid(request.terminalId);
        let controller: HerdrTerminalController;
        try {
          controller = this.startController(request.terminalId, grid);
        } catch {
          return unavailableControl(request.terminalId, "herdr_unavailable");
        }
        const created: TerminalLease = {
          leaseToken: randomUUID(),
          owner: { principalId: request.surfaceClientId },
          grid,
          expiresAtMs: 0,
          controller,
          expiryTimer: undefined,
        };
        void controller.done.then(() => {
          if (this.leases.get(request.terminalId) === created) this.drop(request.terminalId, created);
        });
        this.leases.set(request.terminalId, created);
        return this.grant(request.terminalId, created);
      }
      case "renew": {
        if (lease === undefined) return denied(request.terminalId, "lease_required");
        if (lease.owner.principalId !== request.surfaceClientId) {
          return this.contended(request.terminalId, lease);
        }
        if (request.leaseToken !== lease.leaseToken) return denied(request.terminalId, "lease_expired");
        return this.grant(request.terminalId, lease);
      }
      case "release": {
        // Idempotent: releasing a lease that is gone, or was never yours, is
        // already the state the caller wants.
        if (lease !== undefined && lease.leaseToken === request.leaseToken) {
          lease.controller.write(JSON.stringify({ type: "terminal.release" }));
          this.drop(request.terminalId, lease);
        }
        return {
          schemaVersion: 1,
          status: "released",
          terminalId: request.terminalId,
        };
      }
      case "resize": {
        if (lease === undefined) return denied(request.terminalId, "lease_required");
        if (lease.owner.principalId !== request.surfaceClientId) {
          return this.contended(request.terminalId, lease);
        }
        if (request.leaseToken !== lease.leaseToken) return denied(request.terminalId, "lease_expired");
        const columns = request.columns;
        const rows = request.rows;
        if (columns === undefined || rows === undefined) {
          return unavailableControl(request.terminalId, "controller_closed");
        }
        if (!lease.controller.write(JSON.stringify({ type: "terminal.resize", cols: columns, rows }))) {
          this.drop(request.terminalId, lease);
          return unavailableControl(request.terminalId, "controller_closed");
        }
        lease.grid = { ...lease.grid, columns, rows };
        return this.grantResult(request.terminalId, lease);
      }
      case "scroll": {
        if (lease === undefined) return denied(request.terminalId, "lease_required");
        if (lease.owner.principalId !== request.surfaceClientId) {
          return this.contended(request.terminalId, lease);
        }
        if (request.leaseToken !== lease.leaseToken) return denied(request.terminalId, "lease_expired");
        const { direction, lines, column, row } = request;
        if (direction === undefined || lines === undefined) {
          return unavailableControl(request.terminalId, "controller_closed");
        }
        // Herdr routes the wheel by the pane's own modes — mouse report, cursor
        // keys, or pane scrollback — which the surface cannot see (ADR 0144).
        const command = {
          type: "terminal.scroll",
          direction,
          lines,
          source: "wheel",
          ...(column === undefined ? {} : { column }),
          ...(row === undefined ? {} : { row }),
        };
        if (!lease.controller.write(JSON.stringify(command))) {
          this.drop(request.terminalId, lease);
          return unavailableControl(request.terminalId, "controller_closed");
        }
        return this.grantResult(request.terminalId, lease);
      }
    }
  }

  public geometryFor(terminalId: string, surfaceClientId: string): HerdrPaneGrid | undefined {
    this.sweep();
    const lease = this.leases.get(terminalId);
    if (lease === undefined) return undefined;
    const owner = lease.owner.principalId;
    return surfaceClientId === owner || surfaceClientId.startsWith(`${owner}:`) ? lease.grid : undefined;
  }

  public input(request: OperatorTerminalInputRequest): OperatorTerminalInputResult {
    this.sweep();
    const lease = this.leases.get(request.terminalId);
    if (lease === undefined) return denied(request.terminalId, "lease_required");
    if (lease.owner.principalId !== request.surfaceClientId) {
      return {
        schemaVersion: 1,
        status: "contended",
        terminalId: request.terminalId,
        owner: lease.owner,
        expiresAt: new Date(lease.expiresAtMs).toISOString(),
      };
    }
    if (request.leaseToken !== lease.leaseToken) return denied(request.terminalId, "lease_expired");
    const written = lease.controller.write(
      JSON.stringify({ type: "terminal.input", bytes: request.dataBase64 }),
    );
    if (!written) {
      this.drop(request.terminalId, lease);
      return {
        schemaVersion: 1,
        status: "unavailable",
        terminalId: request.terminalId,
        reason: "controller_closed",
      };
    }
    return {
      schemaVersion: 1,
      status: "delivered",
      terminalId: request.terminalId,
    };
  }

  public close(): void {
    for (const [terminalId, lease] of this.leases) this.drop(terminalId, lease);
  }

  private grant(terminalId: string, lease: TerminalLease): OperatorTerminalControlResult {
    lease.leaseToken = randomUUID();
    lease.expiresAtMs = this.clock() + this.leaseTtlMs;
    if (lease.expiryTimer !== undefined) clearTimeout(lease.expiryTimer);
    lease.expiryTimer = setTimeout(() => {
      if (this.leases.get(terminalId) === lease) this.drop(terminalId, lease);
    }, this.leaseTtlMs);
    lease.expiryTimer.unref?.();
    return this.grantResult(terminalId, lease);
  }

  private grantResult(terminalId: string, lease: TerminalLease): OperatorTerminalControlResult {
    return {
      schemaVersion: 1,
      status: "granted",
      grant: {
        schemaVersion: 1,
        terminalId,
        leaseToken: lease.leaseToken,
        owner: lease.owner,
        expiresAt: new Date(lease.expiresAtMs).toISOString(),
      },
    };
  }

  private contended(terminalId: string, lease: TerminalLease): OperatorTerminalControlResult {
    return {
      schemaVersion: 1,
      status: "contended",
      terminalId,
      owner: lease.owner,
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
    };
  }

  private drop(terminalId: string, lease: TerminalLease): void {
    if (lease.expiryTimer !== undefined) clearTimeout(lease.expiryTimer);
    lease.controller.close();
    if (this.leases.get(terminalId) === lease) this.leases.delete(terminalId);
  }

  private sweep(): void {
    const now = this.clock();
    for (const [terminalId, lease] of this.leases) {
      if (lease.expiresAtMs <= now) this.drop(terminalId, lease);
    }
  }
}

interface TerminalLease {
  leaseToken: string;
  readonly owner: OperatorTerminalControlOwner;
  grid: HerdrPaneGrid | undefined;
  expiresAtMs: number;
  readonly controller: HerdrTerminalController;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
}

function denied(
  terminalId: string,
  reason: "lease_required" | "lease_expired",
): OperatorTerminalControlResult & OperatorTerminalInputResult {
  return { schemaVersion: 1, status: "denied", terminalId, reason };
}

function unavailableControl(
  terminalId: string,
  reason: "herdr_unavailable" | "terminal_unavailable" | "controller_closed",
): OperatorTerminalControlResult {
  return { schemaVersion: 1, status: "unavailable", terminalId, reason };
}

function startHerdrTerminalController(
  terminalId: string,
  grid: HerdrPaneGrid | undefined,
): HerdrTerminalController {
  const geometry = grid === undefined ? [] : ["--cols", String(grid.columns), "--rows", String(grid.rows)];
  const child = spawn("herdr", ["terminal", "session", "control", terminalId, ...geometry], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  // The control stream echoes rendered frames; drain them so the pipe never
  // backpressures Herdr. The observe session owns actual frame delivery.
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", () => {});
  const done = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
  return {
    write: (line) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) return false;
      child.stdin.write(`${line}\n`);
      return true;
    },
    done,
    close: () => {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
