import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { logger } from "../app/log.ts";
import type { OperatorConversationServiceResult } from "@clankie/protocol";

type StartResult = Extract<OperatorConversationServiceResult, { op: "start_agent" }>;
type Start = {
  caller: string;
  result?: StartResult;
  paneId?: string;
  /** Its service stopped before it settled, so nothing here will finish it. */
  interrupted?: boolean;
};

const ReceiptsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  starts: z.array(
    z.strictObject({
      startId: z.string(),
      caller: z.string(),
      paneId: z.string().optional(),
      // The places list is a read of its moment, so it isn't kept.
      result: z
        .strictObject({
          status: z.enum(["started", "refused"]),
          seatId: z.string().optional(),
          detail: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

/**
 * Service-owned starts outlive HTTP requests. Status reads never dispatch a hire or brief.
 * Receipts outlive the service too (#735), so a restart can't turn a finished hire into an
 * unavailable receipt; the brief itself is never kept, so nothing can be replayed from here.
 */
export class ConnectorStarts {
  private readonly starts = new Map<string, Start>();
  private readonly path: string | undefined;
  private readonly hired: (seatId: string) => boolean;

  public constructor(options: { path?: string; hired?: (seatId: string) => boolean } = {}) {
    this.path = options.path;
    this.hired = options.hired ?? (() => false);
    if (this.path === undefined || !existsSync(this.path)) return;
    try {
      for (const { startId, caller, paneId, result } of ReceiptsSchema.parse(
        JSON.parse(readFileSync(this.path, "utf8")),
      ).starts)
        this.starts.set(startId, {
          caller,
          ...(paneId === undefined ? {} : { paneId }),
          ...(result === undefined
            ? { interrupted: true }
            : {
                result: {
                  op: "start_agent",
                  schemaVersion: 1,
                  places: [],
                  status: result.status,
                  ...(result.seatId === undefined ? {} : { seatId: result.seatId }),
                  ...(result.detail === undefined ? {} : { detail: result.detail }),
                },
              }),
        });
    } catch (error) {
      // Receipts only report; a hire's truth is its own record, which list_agents reads.
      logger.warn(
        {
          event: "connector.start_agent.receipts_unreadable",
          error: error instanceof Error ? error.name : "unknown",
        },
        "Start receipts couldn't be read; older receipts answer unavailable",
      );
    }
  }

  private save(): void {
    if (this.path === undefined) return;
    const starts = [...this.starts].map(([startId, { caller, paneId, result }]) => ({
      startId,
      caller,
      ...(paneId === undefined ? {} : { paneId }),
      ...(result === undefined || result.status === "pending" || result.status === "places"
        ? {}
        : {
            result: {
              status: result.status,
              ...(result.seatId === undefined ? {} : { seatId: result.seatId }),
              ...(result.detail === undefined ? {} : { detail: result.detail }),
            },
          }),
    }));
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const next = `${this.path}.next`;
      writeFileSync(next, JSON.stringify({ schemaVersion: 1, starts }), { mode: 0o600 });
      renameSync(next, this.path);
    } catch (error) {
      // A receipt that can't be kept must not fail the hire it reports on.
      logger.warn(
        {
          event: "connector.start_agent.receipts_unsaved",
          error: error instanceof Error ? error.name : "unknown",
        },
        "Start receipt couldn't be saved; it won't survive a restart",
      );
    }
  }

  /** The hire records decide what a start cut off by a restart became. */
  private interrupted(startId: string, paneId: string | undefined): StartResult {
    const answer = {
      op: "start_agent" as const,
      schemaVersion: 1 as const,
      places: [] as StartResult["places"],
      startId,
    };
    if (paneId === undefined)
      return {
        ...answer,
        status: "refused",
        detail:
          "The service restarted while this hire was starting, before it had a pane. Inspect list_agents before any new hire; the original brief was not replayed.",
      };
    return this.hired(paneId)
      ? {
          ...answer,
          status: "started",
          seatId: paneId,
          detail:
            "The service restarted during this hire and its record shows it started. Check list_agents and read_agent that it took its brief; the brief was not replayed.",
        }
      : {
          ...answer,
          status: "refused",
          seatId: paneId,
          detail: `The service restarted while this hire was starting, and no hire is recorded on pane ${paneId}. Inspect list_agents before any new hire; the original brief was not replayed.`,
        };
  }

  public read(startId: string, caller: string): StartResult {
    const start = this.starts.get(startId);
    if (!start || start.caller !== caller)
      return {
        op: "start_agent",
        schemaVersion: 1,
        status: "refused",
        places: [],
        detail:
          "That start receipt is unavailable (it may predate a service restart). Inspect list_agents before any new hire; nothing was started or replayed by this read.",
      };
    if (start.interrupted) return this.interrupted(startId, start.paneId);
    return start.result
      ? { ...start.result, startId }
      : {
          op: "start_agent",
          schemaVersion: 1,
          status: "pending",
          places: [],
          startId,
          ...(start.paneId === undefined ? {} : { seatId: start.paneId }),
          detail:
            "The service is preparing this hire and retains its original brief. Read start_agent with only startId for progress; do not repeat the hire. A pane ID appears once allocated.",
        };
  }

  public async start(
    caller: string,
    run: (pane: (id: string) => void) => Promise<StartResult>,
  ): Promise<StartResult> {
    // Bound retained status without evicting a start still delivering its brief.
    if (this.starts.size >= 256) {
      for (const [id, start] of this.starts) {
        if (start.result || start.interrupted) this.starts.delete(id);
        if (this.starts.size < 256) break;
      }
    }
    if (this.starts.size >= 256)
      return {
        op: "start_agent",
        schemaVersion: 1,
        status: "refused",
        places: [],
        detail: "Too many hires are still starting; nothing new was started.",
      };
    const startId = randomUUID();
    const start: Start = { caller };
    this.starts.set(startId, start);
    this.save();
    const began = Date.now();
    let allocated!: () => void;
    const pane = new Promise<void>((resolve) => {
      allocated = resolve;
    });
    // This promise belongs to the service, never to a request abort signal. Attach its
    // failure handler immediately, including when the caller disappears before allocation.
    const done = Promise.resolve()
      .then(() =>
        run((paneId) => {
          start.paneId = paneId;
          this.save();
          logger.info(
            { event: "connector.start_agent.pane", startId, paneId, elapsedMs: Date.now() - began },
            "Connector hire allocated a pane",
          );
          allocated();
        }),
      )
      .then(
        (result) => {
          start.result = result;
          this.save();
          logger.info(
            {
              event: "connector.start_agent.completed",
              startId,
              status: result.status,
              elapsedMs: Date.now() - began,
            },
            "Connector hire completed",
          );
          return result;
        },
        (error: unknown) => {
          logger.warn(
            {
              event: "connector.start_agent.failed",
              startId,
              elapsedMs: Date.now() - began,
              error: error instanceof Error ? error.name : "unknown",
            },
            "Connector hire failed after acceptance; inspect its original pane",
          );
          start.result = {
            op: "start_agent",
            schemaVersion: 1,
            status: "refused",
            places: [],
            startId,
            ...(start.paneId === undefined ? {} : { seatId: start.paneId }),
            detail:
              "Startup failed after acceptance and may have created a pane. Inspect list_agents before any new hire; the original brief was not replayed.",
          };
          this.save();
          return start.result;
        },
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5_000);
    });
    try {
      const result = await Promise.race([done, pane, budget]);
      return result ?? this.read(startId, caller);
    } finally {
      clearTimeout(timer);
    }
  }
}
