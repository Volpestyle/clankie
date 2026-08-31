import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { createConnection, type Socket } from "node:net";

import { herdrSummariesPath } from "./herdr-summaries.ts";

const FLEET_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
] as const;

interface FleetWaiter {
  readonly resolve: (cursor: string) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One cursor shared by every live fleet reader. */
export class FleetChangeClock {
  private readonly instanceId = randomUUID();
  private sequence = 0;
  private readonly waiters = new Set<FleetWaiter>();

  public current(): string {
    return `${this.instanceId}:${this.sequence}`;
  }

  public touch(): string {
    this.sequence += 1;
    const cursor = this.current();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(cursor);
    }
    this.waiters.clear();
    return cursor;
  }

  public wait(cursor: string | undefined, waitMs: number): Promise<string> {
    if (cursor !== this.current() || waitMs <= 0) return Promise.resolve(this.current());
    return new Promise((resolve) => {
      const waiter: FleetWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(this.current());
        }, waitMs),
      };
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  public close(): void {
    const cursor = this.current();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(cursor);
    }
    this.waiters.clear();
  }
}

/**
 * Advance the fleet cursor from Herdr's native event feed. The socket already
 * belongs to the configured session, so there is no second session selector to
 * drift from `clankie herdr status`.
 */
export function watchHerdrFleetChanges(
  clock: FleetChangeClock,
  options: {
    readonly socketPath?: string;
    readonly summariesPath?: string;
    readonly reconnectMs?: number;
  } = {},
): () => void {
  const socketPath = options.socketPath ?? process.env.HERDR_SOCKET_PATH;
  const reconnectMs = options.reconnectMs ?? 1_000;
  let socket: Socket | undefined;
  let discoverySocket: Socket | undefined;
  let summaries: FSWatcher | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const paneIds = new Set<string>();
  const paneSockets = new Map<string, Socket>();

  const connectPaneStatus = (paneId: string): void => {
    if (closed || socketPath === undefined || paneSockets.has(paneId)) return;
    let buffer = "";
    const paneSocket = createConnection(socketPath);
    paneSockets.set(paneId, paneSocket);
    paneSocket.setEncoding("utf8");
    paneSocket.on("connect", () => {
      paneSocket.write(
        `${JSON.stringify({
          id: `clankie-fleet-pane-${randomUUID()}`,
          method: "events.subscribe",
          params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: paneId }] },
        })}\n`,
      );
    });
    paneSocket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const message = JSON.parse(line) as { readonly event?: unknown };
          if (typeof message.event === "string") clock.touch();
        } catch {
          // Herdr owns the local socket. A malformed frame is skipped; the next
          // valid event still advances the cursor.
        }
      }
    });
    paneSocket.on("error", () => paneSocket.destroy());
    paneSocket.on("close", () => {
      if (paneSockets.get(paneId) === paneSocket) paneSockets.delete(paneId);
      // One dead status stream makes the subscription incomplete. Rebuild the
      // snapshot and every stream together unless this pane was just closed.
      if (!closed && paneIds.has(paneId)) socket?.destroy();
    });
  };

  const connectEvents = (): void => {
    if (closed || socketPath === undefined || socketPath.length === 0) return;
    let buffer = "";
    const mainSocket = createConnection(socketPath);
    socket = mainSocket;
    mainSocket.setEncoding("utf8");
    mainSocket.on("connect", () => {
      mainSocket.write(
        `${JSON.stringify({
          id: `clankie-fleet-${randomUUID()}`,
          method: "events.subscribe",
          params: { subscriptions: FLEET_SUBSCRIPTIONS.map((type) => ({ type })) },
        })}\n`,
      );
    });
    mainSocket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const message = JSON.parse(line) as {
            readonly event?: unknown;
            readonly data?: unknown;
          };
          if (typeof message.event === "string") {
            clock.touch();
            const data =
              typeof message.data === "object" && message.data !== null
                ? (message.data as {
                    readonly pane?: { readonly pane_id?: unknown };
                    readonly pane_id?: unknown;
                  })
                : undefined;
            const paneId =
              typeof data?.pane?.pane_id === "string"
                ? data.pane.pane_id
                : typeof data?.pane_id === "string"
                  ? data.pane_id
                  : undefined;
            if (paneId !== undefined && message.event === "pane_created" && !paneIds.has(paneId)) {
              paneIds.add(paneId);
              connectPaneStatus(paneId);
            } else if (paneId !== undefined && message.event === "pane_closed" && paneIds.delete(paneId)) {
              paneSockets.get(paneId)?.destroy();
            }
          }
        } catch {
          // Herdr owns the local socket. A malformed frame is skipped; the next
          // valid event still advances the cursor.
        }
      }
    });
    mainSocket.on("error", () => mainSocket.destroy());
    mainSocket.on("close", () => {
      if (socket === mainSocket) socket = undefined;
      paneIds.clear();
      for (const paneSocket of paneSockets.values()) paneSocket.destroy();
      paneSockets.clear();
      if (closed) return;
      reconnect = setTimeout(connect, reconnectMs);
      reconnect.unref?.();
    });
  };

  const connect = (): void => {
    if (closed || socketPath === undefined || socketPath.length === 0) return;
    let buffer = "";
    let discovered = false;
    const snapshotId = `clankie-fleet-snapshot-${randomUUID()}`;
    const candidate = createConnection(socketPath);
    discoverySocket = candidate;
    candidate.setEncoding("utf8");
    candidate.on("connect", () => {
      candidate.write(`${JSON.stringify({ id: snapshotId, method: "session.snapshot", params: {} })}\n`);
    });
    candidate.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const message = JSON.parse(line) as {
            readonly id?: unknown;
            readonly result?: { readonly snapshot?: { readonly panes?: readonly unknown[] } };
          };
          if (message.id !== snapshotId) continue;
          for (const paneId of (message.result?.snapshot?.panes ?? []).flatMap((value) => {
            if (typeof value !== "object" || value === null) return [];
            const paneId = (value as { readonly pane_id?: unknown }).pane_id;
            return typeof paneId === "string" ? [paneId] : [];
          }))
            paneIds.add(paneId);
          discovered = true;
          candidate.destroy();
          connectEvents();
          for (const paneId of paneIds) connectPaneStatus(paneId);
        } catch {
          candidate.destroy();
        }
      }
    });
    candidate.on("error", () => candidate.destroy());
    candidate.on("close", () => {
      if (discoverySocket === candidate) discoverySocket = undefined;
      if (closed || discovered) return;
      reconnect = setTimeout(connect, reconnectMs);
      reconnect.unref?.();
    });
  };

  const summariesPath = options.summariesPath ?? herdrSummariesPath();
  const summariesDirectory = dirname(summariesPath);
  if (existsSync(summariesDirectory)) {
    summaries = watch(summariesDirectory, (_event, filename) => {
      if (filename === basename(summariesPath)) clock.touch();
    });
    summaries.unref();
  }
  connect();

  return () => {
    closed = true;
    if (reconnect !== undefined) clearTimeout(reconnect);
    summaries?.close();
    discoverySocket?.destroy();
    socket?.destroy();
    for (const paneSocket of paneSockets.values()) paneSocket.destroy();
    paneSockets.clear();
    clock.close();
  };
}
