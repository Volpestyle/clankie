import { randomUUID } from "node:crypto";
import { logger } from "../app/log.ts";
import type { OperatorConversationServiceResult } from "@clankie/protocol";

type StartResult = Extract<OperatorConversationServiceResult, { op: "start_agent" }>;
type Start = {
  caller: string;
  result?: StartResult;
  paneId?: string;
};

/** Service-owned starts outlive HTTP requests. Status reads never dispatch a hire or brief. */
export class ConnectorStarts {
  private readonly starts = new Map<string, Start>();

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
        if (start.result) this.starts.delete(id);
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
