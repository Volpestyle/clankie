import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

/** One already-selected native connection; this function never chooses an endpoint. */
export function codexSocketControl(
  connect: () => Promise<WebSocket | undefined>,
  timeoutMs = 5_000,
  mode: "steer" | "queue" = "steer",
): ExternalCodexControl {
  return async (sessionId, text, _codexHome, _endpoint, beforeDispatch) => {
    let client: CodexAppServerClient | undefined;
    let attempted = false;
    let denied = false;
    try {
      const socket = await connect();
      if (socket === undefined) return undefined;
      client = new CodexAppServerClient(socket, () => {}, timeoutMs);
      if (socket.readyState !== WebSocket.OPEN)
        await new Promise<void>((resolve, reject) => {
          if (socket.readyState !== WebSocket.CONNECTING)
            return reject(new Error("Codex connection is unavailable"));
          const stop = () => {
            clearTimeout(timer);
            socket.off("open", opened);
            socket.off("error", failed);
            socket.off("close", closed);
          };
          const opened = () => {
            stop();
            resolve();
          };
          const failed = (error: Error) => {
            stop();
            reject(error);
          };
          const closed = () => failed(new Error("Codex connection disconnected"));
          const timer = setTimeout(() => failed(new Error("Codex connection timed out")), timeoutMs);
          socket.once("open", opened);
          socket.once("error", failed);
          socket.once("close", closed);
        });
      await client.initialize(mode === "queue");
      // Read never resumes or loads a stored thread on an unrelated server.
      const read = (await client.request("thread/read", { threadId: sessionId })) as {
        thread?: { id?: string; status?: { type?: string; activeFlags?: string[] } };
      };
      if (
        read.thread?.id !== sessionId ||
        !["active", ...(mode === "queue" ? ["idle", "systemError"] : [])].includes(
          read.thread.status?.type ?? "",
        )
      )
        return undefined;
      if (mode === "steer" && read.thread.status?.activeFlags?.some((flag) => /waiting/iu.test(flag)))
        return {
          outcome: "undelivered",
          detail: "Codex is waiting for owner input or approval; no message was sent.",
        };
      let turnId: string | undefined;
      if (mode === "steer") {
        const page = (await client.request("thread/turns/list", {
          threadId: sessionId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        })) as { data?: { id?: string; status?: string }[] };
        const turn = page.data?.[0];
        if (turn?.status !== "inProgress" || typeof turn.id !== "string") return undefined;
        turnId = turn.id;
      }
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
      if (mode === "queue") {
        const clientUserMessageId = randomUUID();
        const result = (await client.request("thread/queue/add", {
          threadId: sessionId,
          input: [{ type: "text", text, text_elements: [] }],
          clientUserMessageId,
        })) as { queuedSubmission?: { id?: string; clientUserMessageId?: string } };
        if (
          typeof result.queuedSubmission?.id !== "string" ||
          result.queuedSubmission.id.length === 0 ||
          result.queuedSubmission.clientUserMessageId !== clientUserMessageId
        )
          throw new Error("Codex did not confirm the queued submission");
        return { outcome: "delivered", state: "queued" };
      }
      const result = (await client.request("turn/steer", {
        threadId: sessionId,
        expectedTurnId: turnId,
        input: [{ type: "text", text, text_elements: [] }],
      })) as { turnId?: string };
      if (result.turnId !== turnId) throw new Error("Codex did not confirm the selected active turn");
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
            detail: `Codex ${mode} was not confirmed; inspect the exact session before resending: ${String(error)}`,
          }
        : undefined;
    } finally {
      client?.close();
    }
  };
}

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
    const control = codexSocketControl(
      async () =>
        new WebSocket("ws://localhost/", {
          handshakeTimeout: timeoutMs,
          createConnection: () => stream,
        }),
      timeoutMs,
    );
    try {
      return await control(sessionId, text, undefined, undefined, beforeDispatch);
    } finally {
      stream.destroy();
      child.kill("SIGTERM");
    }
  };
}
