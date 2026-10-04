import { createServer } from "node:http";
import type { Socket } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";

const SessionId = z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u);
const MessageId = z.string().regex(/^msg_[A-Za-z0-9]{8,128}$/u);
const Frame = z.object({
  id: z.string().min(1).max(100),
  method: z.string().max(30).optional(),
  input: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.string().max(500).optional(),
});
const Claim = z.object({
  sessionId: SessionId,
  messageId: MessageId,
  text: z
    .string()
    .min(1)
    .max(128 * 1024),
});

export interface OpenCodeController {
  readonly endpoint: string;
  readonly token: string;
  /** Admission is armed only after the native allocation is returned and captured. */
  bind(check: (socket: Socket) => Promise<boolean>, guard: () => Promise<void>): void;
  request(
    method: "initialize" | "status" | "send" | "history" | "settlement" | "interrupt" | "exit",
    input?: unknown,
    timeoutMs?: number,
    beforeDispatch?: () => Promise<boolean>,
  ): Promise<unknown>;
  select(sessionId: string): void;
  pending(): { readonly messageId: string } | undefined;
  acknowledge(messageId: string): Promise<void>;
  close(): Promise<void>;
}

/** One native TUI connection for one controller-created launch. No reconnect/adoption. */
export async function createOpenCodeController(input: {
  readonly receiptsPath: string;
  readonly fence?: DeliveryFence;
  readonly timeoutMs?: number;
  readonly onRetire?: () => void | Promise<void>;
}): Promise<OpenCodeController> {
  const token = randomBytes(32).toString("hex");
  const fence = input.fence ?? new DeliveryFence(input.receiptsPath);
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: () => "clankie-native-worker",
  });
  const transports = new Set<Socket>();
  server.on("connection", (socket) => {
    transports.add(socket);
    socket.once("close", () => transports.delete(socket));
  });
  let retirement: Promise<void> | undefined;
  let peer: WebSocket | undefined;
  let transport: Socket | undefined;
  let check: ((socket: Socket) => Promise<boolean>) | undefined;
  let guard: (() => Promise<void>) | undefined;
  let sessionId: string | undefined;
  let retired = false;
  let acceptedOnce = false;
  let candidate = false;
  let lastAcknowledgment: string | undefined;
  let activeSend: { messageId: string; text: string } | undefined;
  let activeExit: { beforeDispatch?: () => Promise<boolean> } | undefined;
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const waiters = new Set<() => void>();
  const unavailable = () => new Error("Original OpenCode native controller unavailable; no automatic retry");
  const retire = (): Promise<void> => {
    if (retirement) return retirement;
    retired = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(unavailable());
    }
    pending.clear();
    for (const wake of waiters) wake();
    waiters.clear();
    // Publish the promise before closing sockets, whose synchronous listeners
    // can request retirement again. Only owned transports/config are retired.
    retirement = Promise.resolve().then(async () => {
      for (const connection of websocket.clients) connection.terminate();
      for (const socket of transports) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => websocket.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
      await input.onRetire?.();
    });
    // Event-driven retirement has no awaiting caller; retain the rejection for
    // explicit close while preventing an unhandled promise rejection.
    void retirement.catch(() => {});
    return retirement;
  };
  const retireFromEvent = () => {
    void retire();
  };
  const current = async () => {
    try {
      const original = peer;
      if (retired || !original || original.readyState !== WebSocket.OPEN || !transport || !check || !guard)
        throw unavailable();
      if (!(await check(transport))) throw unavailable();
      await guard();
      if (retired || original !== peer || original.readyState !== WebSocket.OPEN || !(await check(transport)))
        throw unavailable();
    } catch {
      void retire();
      throw unavailable();
    }
  };
  const handle = async (raw: Buffer) => {
    const original = peer;
    let frame: z.infer<typeof Frame>;
    try {
      frame = Frame.parse(JSON.parse(raw.toString()));
    } catch {
      void retire();
      return;
    }
    if (!frame.method) {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(new Error("Native OpenCode action unavailable"));
      else waiter.resolve(frame.result);
      return;
    }
    try {
      await current();
      if (original !== peer) throw unavailable();
      if (frame.method === "authorize") {
        const action = z
          .object({ action: z.enum(["initialize", "send", "history", "interrupt", "exit"]) })
          .parse(frame.input).action;
        if (action !== "initialize" && !sessionId) throw unavailable();
        if (action === "exit") {
          if (!activeExit || (activeExit.beforeDispatch && !(await activeExit.beforeDispatch())))
            throw unavailable();
        }
      } else if (frame.method === "claim") {
        const claim = Claim.parse(frame.input);
        if (
          claim.sessionId !== sessionId ||
          fence.pending(sessionId) ||
          activeSend?.messageId !== claim.messageId ||
          activeSend.text !== claim.text
        )
          throw unavailable();
        fence.begin(sessionId, {
          sessionId,
          messageId: claim.messageId,
          fingerprint: deliveryFingerprint(claim.text),
        });
      } else if (frame.method === "receipt") {
        const receipt = z
          .object({ sessionId: SessionId, messageId: MessageId, outcome: z.enum(["accepted", "not-sent"]) })
          .parse(frame.input);
        if (receipt.sessionId !== sessionId || fence.pending(sessionId)?.messageId !== receipt.messageId)
          throw unavailable();
        if (receipt.outcome === "not-sent") fence.reconcile(sessionId, receipt.messageId);
        else lastAcknowledgment = receipt.messageId;
        // Acceptance alone does not clear the fence: the final native route
        // check/result and fresh controller process/admission fence must pass.
      } else throw unavailable();
      await current();
      original?.send(JSON.stringify({ id: frame.id, result: true }));
    } catch {
      if (original?.readyState === WebSocket.OPEN)
        original.send(JSON.stringify({ id: frame.id, error: "Control admission refused" }));
    }
  };
  server.on("upgrade", (request, socket, head) => {
    const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((part) => part.trim()) ?? [];
    const supplied = Buffer.from(protocols[1] ?? "");
    if (
      request.url !== "/worker" ||
      protocols[0] !== "clankie-native-worker" ||
      supplied.length !== token.length ||
      !timingSafeEqual(supplied, Buffer.from(token)) ||
      retired ||
      acceptedOnce ||
      candidate
    ) {
      socket.destroy();
      return;
    }
    candidate = true;
    websocket.handleUpgrade(request, socket, head, (connected) => {
      const nativeSocket = socket as Socket;
      connected.once("close", retireFromEvent);
      connected.once("error", retireFromEvent);
      const deadline = Date.now() + (input.timeoutMs ?? 20_000);
      const admit = async () => {
        while (!check && !retired && connected.readyState === WebSocket.OPEN && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        if (retired || !check || !(await check(nativeSocket))) {
          candidate = false;
          void retire();
          return;
        }
        if (retired || connected.readyState !== WebSocket.OPEN || acceptedOnce) {
          candidate = false;
          connected.close();
          return;
        }
        acceptedOnce = true;
        peer = connected;
        transport = nativeSocket;
        connected.on("message", (data) => {
          void handle(Buffer.from(data as Buffer));
        });
        connected.on("close", retireFromEvent);
        connected.on("error", retireFromEvent);
        for (const wake of waiters) wake();
        waiters.clear();
      };
      void admit().catch(() => {
        candidate = false;
        void retire();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw unavailable();
  return {
    endpoint: `ws://127.0.0.1:${address.port}/worker`,
    token,
    bind(verify, admit) {
      if (check || retired) throw unavailable();
      check = verify;
      guard = admit;
    },
    select(id) {
      if (retired || sessionId || !SessionId.safeParse(id).success) throw unavailable();
      sessionId = id;
    },
    pending: () => (sessionId ? fence.pending(sessionId) : undefined),
    async request(method, value, timeoutMs = 15_000, beforeDispatch) {
      const deadline = Date.now() + timeoutMs;
      if (!peer && !retired)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(wake);
            resolve();
          }, timeoutMs);
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          waiters.add(wake);
        });
      await current();
      if (method === "exit") {
        if (!sessionId || activeExit) throw unavailable();
        activeExit = beforeDispatch === undefined ? {} : { beforeDispatch };
      }
      if (method === "send" && (!sessionId || fence.pending(sessionId)))
        throw new Error("An earlier native delivery is uncertain; no resend");
      if (method === "send") {
        if (beforeDispatch && !(await beforeDispatch().catch(() => false)))
          return {
            outcome: "unavailable",
            detail: "Peer authority changed before native dispatch; nothing was sent.",
          };
        if (activeSend) throw new Error("Another native dispatch is pending");
        activeSend = z
          .object({
            messageId: MessageId,
            text: z
              .string()
              .min(1)
              .max(128 * 1024),
          })
          .parse(value);
      }
      const id = randomUUID();
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => {
              pending.delete(id);
              void retire();
              reject(unavailable());
            },
            Math.max(1, deadline - Date.now()),
          );
          pending.set(id, { resolve, reject, timer });
          peer!.send(JSON.stringify({ id, method, input: value }), (error) => {
            if (error) {
              clearTimeout(timer);
              pending.delete(id);
              void retire();
              reject(unavailable());
            }
          });
        });
        // Native exit may destroy this exact connection before its reply.
        // The caller confirms the original terminal's disappearance instead.
        if (method !== "exit") await current();
        return result;
      } finally {
        if (method === "send") activeSend = undefined;
        if (method === "exit") activeExit = undefined;
      }
    },
    async acknowledge(id) {
      await current();
      if (!sessionId || lastAcknowledgment !== id || !fence.reconcile(sessionId, id)) throw unavailable();
      lastAcknowledgment = undefined;
    },
    close: retire,
  };
}
