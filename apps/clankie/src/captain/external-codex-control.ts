import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import { CodexAppServerClient } from "./codex-app-server.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";

/** Undefined permits the native queue only because no mutating request was sent. */
export type ExternalCodexControl = (
  sessionId: string,
  text: string,
  codexHome?: string,
  /** Exact --remote endpoint observed on this pane, never a guessed socket. */
  endpoint?: string,
  /** Recheck peer authority after all native preparation and before the write. */
  beforeDispatch?: () => Promise<boolean>,
) => Promise<FleetSeatDelivery | undefined>;

/** Proxy is a raw WebSocket stream, including HTTP Upgrade, not JSONL. */
export function codexProxyControl(
  command = "codex",
  args: readonly string[] = ["app-server", "proxy"],
  timeoutMs = 5_000,
): ExternalCodexControl {
  return async (sessionId, text, codexHome, endpoint, beforeDispatch) => {
    if (endpoint !== undefined && !endpoint.startsWith("unix://")) return undefined;
    const proxyArgs =
      endpoint === undefined ? [...args] : [...args, "--sock", endpoint.slice("unix://".length)];
    const child = spawn(command, proxyArgs, {
      stdio: ["pipe", "pipe", "ignore"],
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
    });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    child.on("error", (error) => stream.destroy(error));
    child.on("exit", () => stream.destroy());
    // A custom connection prevents DNS/TCP fallback: only this proxy is used.
    const socket = new WebSocket("ws://localhost/", {
      handshakeTimeout: timeoutMs,
      createConnection: () => stream,
    });
    const client = new CodexAppServerClient(socket, () => {}, timeoutMs);
    let attempted = false;
    let denied = false;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("Codex proxy disconnected")));
      });
      await client.initialize();
      // Read never resumes or loads a stored thread on an unrelated server.
      const read = (await client.request("thread/read", { threadId: sessionId })) as {
        thread?: { id?: string; status?: { type?: string; activeFlags?: string[] } };
      };
      if (read.thread?.id !== sessionId || read.thread.status?.type !== "active") return undefined;
      if (read.thread.status.activeFlags?.some((flag) => /waiting/iu.test(flag)))
        return {
          outcome: "undelivered",
          detail: "Codex is waiting for owner input or approval; no message was sent.",
        };
      const page = (await client.request("thread/turns/list", {
        threadId: sessionId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      })) as { data?: { id?: string; status?: string }[] };
      const turn = page.data?.[0];
      if (turn?.status !== "inProgress" || typeof turn.id !== "string") return undefined;
      if (beforeDispatch) {
        try {
          if (!(await beforeDispatch())) throw new Error("Peer authority changed; nothing was sent.");
        } catch (error) {
          denied = true;
          throw error;
        }
      }
      // Once written, even a timeout/rejection cannot authorize a second send.
      attempted = true;
      const result = (await client.request("turn/steer", {
        threadId: sessionId,
        expectedTurnId: turn.id,
        input: [{ type: "text", text, text_elements: [] }],
      })) as { turnId?: string };
      if (result.turnId !== turn.id) throw new Error("Codex did not confirm the selected active turn");
      return { outcome: "delivered", state: "steered" };
    } catch (error) {
      if (denied)
        return {
          outcome: "undelivered",
          deliveryStage: "unavailable",
          detail: `Codex authority changed before dispatch; nothing was sent: ${String(error)}`,
        };
      return attempted
        ? {
            outcome: "unconfirmed",
            detail: `Codex steering was not confirmed; inspect the exact session before resending: ${String(error)}`,
          }
        : undefined;
    } finally {
      client.close();
      stream.destroy();
      child.kill("SIGTERM");
    }
  };
}
