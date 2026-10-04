import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createPiWorkerController } from "../src/captain/pi-worker-controller.ts";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";
import { connectPiWorker } from "../../../integrations/pi-plugin/worker-connection.mjs";
import { createPiWorkerRuntime } from "../../../integrations/pi-plugin/worker-runtime.mjs";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-controller-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "receipts.json");
  const fence = new DeliveryFence(path);
  const retired = vi.fn();
  const controller = await createPiWorkerController({ fence, timeoutMs: 200, onRetire: retired });
  cleanup.push(() => controller.close());
  const check = vi.fn(async () => true);
  const guard = vi.fn(async () => {});
  controller.bind(check, guard);
  const sessionId = randomUUID();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const context = {
    mode: "tui",
    cwd: directory,
    model: { provider: "native", id: "model" },
    thinkingLevel: "high",
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `${directory}/${sessionId}.jsonl`,
      getSessionDir: () => directory,
      getHeader: () => ({ type: "session", version: 3, id: sessionId, cwd: directory }),
    },
  };
  const nativeSend = vi.fn((message: unknown) => {
    handlers.get("message_start")?.({ message: { ...(message as object), role: "custom" } }, context);
  });
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    sendMessage: nativeSend,
  };
  const connection = connectPiWorker(
    { port: controller.port, token: controller.token },
    (transport: unknown) => createPiWorkerRuntime(pi, transport),
  );
  cleanup.push(() => connection.close());
  handlers.get("session_start")?.({ reason: "startup" }, context);
  const initialized = await controller.request("initialize", { cwd: directory });
  expect(initialized).toEqual(expect.objectContaining({ sessionId, mode: "tui" }));
  controller.select(sessionId);
  return {
    controller,
    sessionId,
    nativeSend,
    check,
    guard,
    retired,
    path,
    fence,
    handlers,
    context,
    connection,
  };
}

test("production native connection requires matching semantic receipt plus final controller fence", async () => {
  const f = await fixture();
  const messageId = randomUUID();
  const result = await f.controller.request("send", { messageId, text: "brief" });
  expect(result).toEqual({ outcome: "accepted", messageId, state: "started" });
  expect(f.fence.pending(f.sessionId)?.messageId).toBe(messageId);
  await f.controller.acknowledge(messageId);
  expect(f.fence.pending(f.sessionId)).toBeUndefined();
  expect(f.nativeSend).toHaveBeenCalledOnce();
});

test("actual controller and extension preserve multibyte brief bytes split across TCP chunks", async () => {
  const original = Socket.prototype.write;
  let splits = 0;
  vi.spyOn(Socket.prototype, "write").mockImplementation(function (this: Socket, chunk: any, ...args: any[]) {
    if (typeof chunk === "string" && chunk.startsWith("{") && chunk.includes("😺")) {
      const bytes = Buffer.from(chunk);
      const boundary = bytes.indexOf(Buffer.from("😺")) + 1;
      splits += 1;
      original.call(this, bytes.subarray(0, boundary));
      setTimeout(() => {
        (original as Function).call(this, bytes.subarray(boundary), ...args);
      }, 5);
      return true;
    }
    return (original as Function).call(this, chunk, ...args) as boolean;
  });
  const f = await fixture();
  const text = "Same native brief 😺 café 漢字";
  const messageId = randomUUID();
  expect(await f.controller.request("send", { messageId, text })).toEqual({
    outcome: "accepted",
    messageId,
    state: "started",
  });
  expect(f.nativeSend).toHaveBeenCalledWith(expect.objectContaining({ content: text }), {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  expect(splits).toBeGreaterThanOrEqual(2);
});

test("process change after native observation retains durable uncertainty across controller restart", async () => {
  const f = await fixture();
  const original = f.nativeSend.getMockImplementation()!;
  f.nativeSend.mockImplementation((message) => {
    original(message);
    f.check.mockResolvedValue(false);
  });
  const messageId = randomUUID();
  await expect(f.controller.request("send", { messageId, text: "original" }, 200)).rejects.toThrow();
  const saved = new DeliveryFence(f.path);
  expect(saved.pending(f.sessionId)?.messageId).toBe(messageId);
  expect(await readFile(f.path, "utf8")).not.toContain("original");
  expect(f.nativeSend).toHaveBeenCalledOnce();
  await f.controller.close();
  expect(f.retired).toHaveBeenCalledOnce();
});

test("native memory queue without message event returns uncertainty and prohibits duplicate dispatch", async () => {
  const f = await fixture();
  f.nativeSend.mockImplementation(() => {});
  const messageId = randomUUID();
  const result = await f.controller.request("send", { messageId, text: "queued", timeoutMs: 5 }, 200);
  expect(result).toEqual(expect.objectContaining({ outcome: "unconfirmed", messageId }));
  await expect(f.controller.request("send", { messageId: randomUUID(), text: "queued" })).rejects.toThrow();
  expect(new DeliveryFence(f.path).pending(f.sessionId)?.messageId).toBe(messageId);
  expect(f.nativeSend).toHaveBeenCalledOnce();
});

test("held initial guard then process replacement sends no native invocation", async () => {
  const f = await fixture();
  let release!: () => void;
  f.guard.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const sending = f.controller
    .request("send", { messageId: randomUUID(), text: "blocked" })
    .catch((error: Error) => error);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.check.mockResolvedValue(false);
  release();
  expect(await sending).toBeInstanceOf(Error);
  expect(f.nativeSend).not.toHaveBeenCalled();
});

test("close closes only owned listener and transports without invoking native shutdown", async () => {
  const f = await fixture();
  await f.controller.close();
  expect(f.retired).toHaveBeenCalledOnce();
  await expect(f.controller.request("status")).rejects.toThrow();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: f.controller.port });
    socket.once("error", () => {
      socket.destroy();
      resolve();
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("retired listener stayed open"));
    });
  });
  expect(f.nativeSend).not.toHaveBeenCalled();
});

test("lost connection after native dispatch does not reconnect or clear its receipt", async () => {
  const f = await fixture();
  f.nativeSend.mockImplementation(() => {
    f.connection.close();
  });
  const messageId = randomUUID();
  await expect(f.controller.request("send", { messageId, text: "uncertain" }, 200)).rejects.toThrow();
  expect(new DeliveryFence(f.path).pending(f.sessionId)?.messageId).toBe(messageId);
  expect(f.nativeSend).toHaveBeenCalledOnce();
});
