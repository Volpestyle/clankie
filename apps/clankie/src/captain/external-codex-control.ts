import type { SeatEvent } from "@clankie/agent-hosts";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import { z } from "zod";
import { CodexAppServerClient } from "./codex-app-server.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";
import type { CurrentCheck } from "./peer-seat-messages.ts";

/** Undefined permits the native queue only because no mutating request was sent. */
export type ExternalCodexControl = (
  sessionId: string,
  text: string,
  codexHome?: string,
  /** Exact --remote endpoint observed on this pane, never a guessed socket. */
  endpoint?: string,
  /** Recheck peer authority after all native preparation and before the write. */
  beforeDispatch?: (() => Promise<boolean>) & CurrentCheck,
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
    let messageId: string | undefined;
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
      if (mode === "queue") {
        const clientUserMessageId = randomUUID();
        messageId = `codex-input:${clientUserMessageId}`;
        attempted = true;
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
        return { outcome: "delivered", state: "queued", messageId };
      }
      if (turnId === undefined) return undefined;
      messageId = turnId;
      attempted = true;
      const result = (await client.request("turn/steer", {
        threadId: sessionId,
        expectedTurnId: turnId,
        input: [{ type: "text", text, text_elements: [] }],
      })) as { turnId?: string };
      if (result.turnId !== turnId) throw new Error("Codex did not confirm the selected active turn");
      return { outcome: "delivered", state: "steered", messageId: turnId };
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
            ...(messageId === undefined ? {} : { messageId }),
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
  mode: "steer" | "queue" = "steer",
): ExternalCodexControl {
  return async (sessionId, text, codexHome, endpoint, beforeDispatch) => {
    if (endpoint !== undefined && !endpoint.startsWith("unix://")) return undefined;
    return withCodexProxy(command, args, timeoutMs, codexHome, endpoint, async (connect) =>
      codexSocketControl(connect, timeoutMs, mode)(sessionId, text, undefined, undefined, beforeDispatch),
    );
  };
}

/** A native queue input ID is distinct from the turn ID assigned when it runs. */
function codexRecordedCompletion(
  value: unknown,
  sessionId: string,
  messageId: string,
): SeatEvent | undefined {
  const parsed = completionThread.safeParse(value);
  if (!parsed.success || parsed.data.thread.id !== sessionId) return undefined;
  const clientId = messageId.startsWith("codex-input:") ? messageId.slice("codex-input:".length) : undefined;
  const turns = parsed.data.thread.turns.filter((turn) =>
    clientId === undefined
      ? turn.id === messageId
      : turn.items.some((item) => item.type === "userMessage" && item.clientId === clientId),
  );
  // Ambiguous/missing identity is never settled by the latest pane status or equal text.
  if (turns.length !== 1) return undefined;
  const turn = turns[0]!;
  if (!["completed", "failed", "interrupted"].includes(turn.status)) return undefined;
  return {
    type: "turn_completed",
    messageId,
    nativeTurnId: turn.id,
    at: new Date().toISOString(),
    ok: turn.status === "completed",
    stopReason: turn.status,
    text: turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text ?? "")
      .join("\n")
      .slice(-12000),
  };
}

const completionThread = z.object({
  thread: z.object({
    id: z.string(),
    turns: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        items: z.array(
          z
            .object({
              type: z.string(),
              clientId: z.string().nullable().optional(),
              text: z.string().optional(),
            })
            .passthrough(),
        ),
      }),
    ),
  }),
});

/** Read retained turns on the exact observed server. Never resumes, sends or answers anything. */
export async function codexSocketSettled(
  connect: () => Promise<WebSocket | undefined>,
  sessionId: string,
  messageId: string,
  signal: AbortSignal,
  guard: () => Promise<void>,
  intervalMs = 500,
): Promise<SeatEvent> {
  signal.throwIfAborted();
  await guard();
  const socket = await connect();
  if (!socket) throw new Error("Original Codex completion connection unavailable");
  const abort = () => socket.terminate();
  signal.addEventListener("abort", abort, { once: true });
  let client: CodexAppServerClient | undefined;
  try {
    if (socket.readyState !== WebSocket.OPEN)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Codex completion connection timed out")), 5000);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          socket.off("open", opened);
          socket.off("error", failed);
          socket.off("close", closed);
          if (error) reject(error);
          else resolve();
        };
        const opened = () => finish();
        const failed = (error: Error) => finish(error);
        const closed = () => finish(new Error("Codex completion connection closed"));
        socket.once("open", opened);
        socket.once("error", failed);
        socket.once("close", closed);
      });
    signal.throwIfAborted();
    client = new CodexAppServerClient(socket, () => {}, 5000);
    await client.initialize();
    for (;;) {
      signal.throwIfAborted();
      await guard();
      const read = await client.request("thread/read", { threadId: sessionId, includeTurns: true });
      signal.throwIfAborted();
      await guard();
      const completed = codexRecordedCompletion(read, sessionId, messageId);
      if (completed) return completed;
      await delay(intervalMs, undefined, { signal });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    client?.close();
    socket.terminate();
  }
}

export function codexProxySettled(
  sessionId: string,
  messageId: string,
  signal: AbortSignal,
  endpoint: string | undefined,
  codexHome: string | undefined,
  guard: () => Promise<void>,
): Promise<SeatEvent> {
  return withCodexProxy("codex", ["app-server", "proxy"], 5000, codexHome, endpoint, (connect) =>
    codexSocketSettled(connect, sessionId, messageId, signal, guard),
  );
}

async function withCodexProxy<T>(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  codexHome: string | undefined,
  endpoint: string | undefined,
  run: (connect: () => Promise<WebSocket>) => Promise<T>,
): Promise<T> {
  if (endpoint !== undefined && !endpoint.startsWith("unix://"))
    throw new Error("Unsupported Codex endpoint");
  const proxyArgs = endpoint === undefined ? [...args] : [...args, "--sock", endpoint.slice(7)];
  const child = spawn(command, proxyArgs, {
    stdio: ["pipe", "pipe", "ignore"],
    env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
  });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.on("error", (error) => stream.destroy(error));
  child.on("exit", () => stream.destroy());
  try {
    return await run(
      async () =>
        new WebSocket("ws://localhost/", {
          handshakeTimeout: timeoutMs,
          createConnection: () => stream,
        }),
    );
  } finally {
    stream.destroy();
    child.kill("SIGTERM");
  }
}
