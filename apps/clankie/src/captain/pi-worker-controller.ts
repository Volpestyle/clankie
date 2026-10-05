import { createServer, type Socket } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";

const Id = z.string().uuid();
const Frame = z.object({
  id: z.string().min(1).max(100),
  method: z.string().max(30).optional(),
  input: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.string().max(500).optional(),
});
const Send = z.object({
  messageId: Id,
  text: z
    .string()
    .min(1)
    .max(128 * 1024),
});
export interface PiWorkerController {
  readonly port: number;
  readonly token: string;
  bind(check: (socket: Socket) => Promise<boolean>, guard: () => Promise<void>): void;
  select(sessionId: string): void;
  request(
    method: "initialize" | "status" | "send" | "settlement" | "interrupt",
    input?: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
  pending(): { readonly messageId: string } | undefined;
  acknowledge(messageId: string): Promise<void>;
  close(): Promise<void>;
}

export async function createPiWorkerController(input: {
  readonly fence: DeliveryFence;
  readonly timeoutMs?: number;
  readonly onRetire?: () => void | Promise<void>;
}): Promise<PiWorkerController> {
  const token = randomBytes(32).toString("hex");
  let peer: Socket | undefined;
  let candidate = false;
  let accepted = false;
  let retired = false;
  let retirement: Promise<void> | undefined;
  let check: ((socket: Socket) => Promise<boolean>) | undefined;
  let guard: (() => Promise<void>) | undefined;
  let sessionId: string | undefined;
  let activeSend: z.infer<typeof Send> | undefined;
  let receipt: string | undefined;
  const sockets = new Set<Socket>();
  const waiters = new Set<() => void>();
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const unavailable = () => new Error("Original native Pi control unavailable; no automatic retry");
  const close = (): Promise<void> => {
    if (retirement) return retirement;
    retired = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(unavailable());
    }
    pending.clear();
    for (const wake of waiters) wake();
    waiters.clear();
    retirement = Promise.resolve().then(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await input.onRetire?.();
    });
    void retirement.catch(() => {});
    return retirement;
  };
  const current = async () => {
    const original = peer;
    try {
      if (retired || !original || original.destroyed || !check || !guard) throw unavailable();
      if (!(await check(original))) throw unavailable();
      await guard();
      if (retired || original !== peer || original.destroyed || !(await check(original))) throw unavailable();
    } catch {
      void close();
      throw unavailable();
    }
  };
  const handle = async (socket: Socket, frame: z.infer<typeof Frame>) => {
    if (socket !== peer || retired) return;
    if (!frame.method) {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(unavailable());
      else waiter.resolve(frame.result);
      return;
    }
    try {
      await current();
      if (frame.method === "authorize") {
        const { action } = z
          .object({ action: z.enum(["initialize", "send", "history", "interrupt"]) })
          .parse(frame.input);
        if (action !== "initialize" && !sessionId) throw unavailable();
      } else if (frame.method === "claim") {
        const claim = Send.extend({ sessionId: Id }).parse(frame.input);
        if (
          claim.sessionId !== sessionId ||
          input.fence.pending(sessionId) ||
          claim.messageId !== activeSend?.messageId ||
          claim.text !== activeSend.text
        )
          throw unavailable();
        input.fence.begin(sessionId, {
          sessionId,
          messageId: claim.messageId,
          fingerprint: deliveryFingerprint(claim.text),
        });
      } else if (frame.method === "receipt") {
        const claim = z
          .object({ sessionId: Id, messageId: Id, outcome: z.enum(["accepted", "not-sent"]) })
          .parse(frame.input);
        if (claim.sessionId !== sessionId || input.fence.pending(sessionId)?.messageId !== claim.messageId)
          throw unavailable();
        if (claim.outcome === "not-sent") input.fence.reconcile(sessionId, claim.messageId);
        else receipt = claim.messageId;
      } else throw unavailable();
      await current();
      socket.write(`${JSON.stringify({ id: frame.id, result: true })}\n`);
    } catch {
      if (!socket.destroyed)
        socket.write(`${JSON.stringify({ id: frame.id, error: "Native Pi admission refused" })}\n`);
    }
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      if (socket === peer) void close();
    });
    socket.once("error", () => {
      if (socket === peer) void close();
      socket.destroy();
    });
    if (retired || candidate || accepted || socket.remoteAddress !== "127.0.0.1") {
      socket.destroy();
      return;
    }
    candidate = true;
    let text = "";
    let pendingBytes = 0;
    const decoder = new StringDecoder("utf8");
    let hello = false;
    let admitted = false;
    const timer = setTimeout(() => {
      void close();
    }, input.timeoutMs ?? 20_000);
    socket.once("close", () => clearTimeout(timer));
    socket.on("data", (chunk: Buffer) => {
      pendingBytes += chunk.length;
      text += decoder.write(chunk);
      if (pendingBytes > 1024 * 1024) {
        void close();
        return;
      }
      while (text.includes("\n")) {
        const end = text.indexOf("\n");
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        pendingBytes = Math.max(0, pendingBytes - Buffer.byteLength(line) - 1);
        try {
          const value: unknown = JSON.parse(line);
          if (!hello) {
            hello = true;
            const supplied = Buffer.from(z.object({ token: z.string() }).parse(value).token);
            if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
              throw unavailable();
            void (async () => {
              const deadline = Date.now() + (input.timeoutMs ?? 20_000);
              while (!check && !retired && !socket.destroyed && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 10));
              if (!check || retired || socket.destroyed || accepted || !(await check(socket)))
                throw unavailable();
              peer = socket;
              await current();
              accepted = true;
              admitted = true;
              clearTimeout(timer);
              socket.write(`${JSON.stringify({ ready: true })}\n`);
              for (const wake of waiters) wake();
              waiters.clear();
            })().catch(() => {
              void close();
            });
          } else {
            if (!admitted) throw unavailable();
            void handle(socket, Frame.parse(value)).catch(() => {
              void close();
            });
          }
        } catch {
          void close();
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw unavailable();
  return {
    port: address.port,
    token,
    bind(verify, admit) {
      if (check || retired) throw unavailable();
      check = verify;
      guard = admit;
    },
    select(id) {
      if (sessionId || !Id.safeParse(id).success) throw unavailable();
      sessionId = id;
    },
    pending: () => (sessionId ? input.fence.pending(sessionId) : undefined),
    async request(method, value, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      if (!accepted && !retired)
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
      if (method === "send") {
        if (!sessionId || input.fence.pending(sessionId) || activeSend) throw unavailable();
        activeSend = Send.parse(value);
      }
      const id = randomUUID();
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => {
              void close();
            },
            Math.max(1, deadline - Date.now()),
          );
          pending.set(id, { resolve, reject, timer });
          peer!.write(`${JSON.stringify({ id, method, input: value })}\n`, (error) => {
            if (error) void close();
          });
        });
        await current();
        return result;
      } finally {
        if (method === "send") activeSend = undefined;
      }
    },
    async acknowledge(id) {
      await current();
      if (!sessionId || receipt !== id || !input.fence.reconcile(sessionId, id)) throw unavailable();
      receipt = undefined;
    },
    close,
  };
}
