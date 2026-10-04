import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import {
  createOpenCodeController,
  type OpenCodeController,
} from "../src/captain/opencode-worker-controller.ts";

const sessionId = "ses_nativeWorker123";
const messageId = "msg_controllerRequest123";
const text = "Inspect the diff";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(path?: string, onRetire?: () => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-controller-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const receiptsPath = path ?? join(directory, "receipts.json");
  const controller = await createOpenCodeController({
    receiptsPath,
    timeoutMs: 100,
    ...(onRetire ? { onRetire } : {}),
  });
  cleanups.push(() => controller.close().catch(() => {}));
  const check = vi.fn(async () => true);
  const guard = vi.fn(async () => {});
  controller.bind(check, guard);
  return { controller, check, guard, receiptsPath };
}

async function native(controller: OpenCodeController, token = controller.token) {
  const peer = new WebSocket(controller.endpoint, ["clankie-native-worker", token]);
  cleanups.push(async () => peer.terminate());
  await new Promise<void>((resolve, reject) => {
    peer.once("open", resolve);
    peer.once("error", reject);
  });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let handler: (method: string, input: unknown) => Promise<unknown> = async () => "idle";
  peer.on("message", async (raw) => {
    const frame = JSON.parse(raw.toString()) as {
      id: string;
      method?: string;
      input?: unknown;
      error?: string;
      result?: unknown;
    };
    if (!frame.method) {
      const waiter = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) waiter?.reject(new Error(frame.error));
      else waiter?.resolve(frame.result);
      return;
    }
    try {
      const result = await handler(frame.method, frame.input);
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ id: frame.id, result }));
    } catch {
      if (peer.readyState === WebSocket.OPEN)
        peer.send(JSON.stringify({ id: frame.id, error: "Native fixture refusal" }));
    }
  });
  return {
    peer,
    handle(fn: typeof handler) {
      handler = fn;
    },
    callback(method: string, input: unknown) {
      const id = randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        peer.send(JSON.stringify({ id, method, input }));
      });
    },
  };
}

test("nonce is routing only: wrong token or unproved kernel peer cannot establish control", async () => {
  const f = await fixture();
  await expect(native(f.controller, "0".repeat(64))).rejects.toThrow();
  f.check.mockResolvedValue(false);
  const unproved = await native(f.controller);
  await expect(f.controller.request("status", undefined, 50)).rejects.toThrow("unavailable");
  await vi.waitFor(() => expect(unproved.peer.readyState).not.toBe(WebSocket.OPEN));
  expect(f.guard).not.toHaveBeenCalled();
});

test("every command brackets authority with the same socket proof; changed root retires permanently", async () => {
  const f = await fixture();
  await native(f.controller);
  expect(await f.controller.request("status")).toBe("idle");
  expect(f.check.mock.calls.length).toBeGreaterThanOrEqual(5);
  f.guard.mockImplementation(async () => {
    f.check.mockResolvedValue(false);
  });
  await expect(f.controller.request("status")).rejects.toThrow("unavailable");
  f.guard.mockResolvedValue();
  f.check.mockResolvedValue(true);
  await expect(f.controller.request("status")).rejects.toThrow("unavailable");
  await expect(native(f.controller)).rejects.toThrow();
});

test("a changed process after native response cannot earn a successful controller result", async () => {
  const f = await fixture();
  const n = await native(f.controller);
  n.handle(async () => {
    f.check.mockResolvedValue(false);
    return "idle";
  });
  await expect(f.controller.request("status")).rejects.toThrow("unavailable");
});

test("revoked peer authority after awaited controller preparation sends no native frame or claim", async () => {
  const f = await fixture();
  const n = await native(f.controller);
  f.controller.select(sessionId);
  await f.controller.request("status");
  let prepared!: () => void;
  let resume!: () => void;
  const preparation = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const continuePreparation = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.guard.mockImplementationOnce(async () => {
    prepared();
    await continuePreparation;
  });
  let authorized = true;
  const beforeDispatch = vi.fn(async () => authorized);
  const received = vi.fn(async () => ({ outcome: "accepted", messageId, state: "queued" }));
  n.handle(received);
  const pending = f.controller.request("send", { messageId, text }, 1000, beforeDispatch);
  await preparation;
  authorized = false;
  resume();
  expect(await pending).toMatchObject({ outcome: "unavailable" });
  expect(beforeDispatch).toHaveBeenCalledOnce();
  expect(received).not.toHaveBeenCalled();
  expect(f.controller.pending()).toBeUndefined();
  authorized = true;
  expect(await f.controller.request("send", { messageId, text }, 1000, beforeDispatch)).toMatchObject({
    outcome: "accepted",
  });
  expect(received).toHaveBeenCalledOnce();
});

test("claim must match the actual controller dispatch and persists before native submission", async () => {
  const f = await fixture();
  const n = await native(f.controller);
  f.controller.select(sessionId);
  await f.controller.request("status");
  await expect(n.callback("claim", { sessionId, messageId, text })).rejects.toThrow("refused");
  n.handle(async (method, input) => {
    expect(method).toBe("send");
    expect(input).toEqual({ messageId, text });
    await expect(n.callback("claim", { sessionId, messageId, text: "substituted" })).rejects.toThrow(
      "refused",
    );
    await n.callback("claim", { sessionId, messageId, text });
    const saved = JSON.parse(await readFile(f.receiptsPath, "utf8"));
    expect(saved[sessionId].messageId).toBe(messageId);
    await n.callback("receipt", { sessionId, messageId, outcome: "accepted" });
    expect(f.controller.pending()).toMatchObject({ messageId });
    return { outcome: "accepted", messageId, state: "queued" };
  });
  expect(await f.controller.request("send", { messageId, text })).toMatchObject({ outcome: "accepted" });
  expect(f.controller.pending()).toMatchObject({ messageId });
  await expect(f.controller.request("send", { messageId, text })).rejects.toThrow("uncertain");
  await f.controller.acknowledge(messageId);
  expect(f.controller.pending()).toBeUndefined();
});

test("claimed transport loss survives controller restart, no reconnect or resend", async () => {
  const f = await fixture();
  const n = await native(f.controller);
  f.controller.select(sessionId);
  n.handle(async () => {
    await n.callback("claim", { sessionId, messageId, text });
    n.peer.close();
    return { outcome: "accepted" };
  });
  await expect(f.controller.request("send", { messageId, text })).rejects.toThrow("unavailable");
  expect(f.controller.pending()).toMatchObject({ messageId });
  await expect(native(f.controller)).rejects.toThrow();
  const restarted = await fixture(f.receiptsPath);
  await native(restarted.controller);
  restarted.controller.select(sessionId);
  expect(restarted.controller.pending()).toMatchObject({ messageId });
  await expect(restarted.controller.request("send", { messageId, text })).rejects.toThrow("uncertain");
});

test("known pre-dispatch refusal clears only its exact claim, not another message", async () => {
  const f = await fixture();
  const n = await native(f.controller);
  f.controller.select(sessionId);
  n.handle(async () => {
    await n.callback("claim", { sessionId, messageId, text });
    await expect(
      n.callback("receipt", { sessionId, messageId: "msg_otherRequest123", outcome: "not-sent" }),
    ).rejects.toThrow();
    expect(f.controller.pending()).toMatchObject({ messageId });
    await n.callback("receipt", { sessionId, messageId, outcome: "not-sent" });
    return { outcome: "unavailable" };
  });
  expect(await f.controller.request("send", { messageId, text })).toMatchObject({ outcome: "unavailable" });
  expect(f.controller.pending()).toBeUndefined();
});

test("timeout retires the generation and cannot authorize a late request or another connection", async () => {
  const f = await fixture();
  const n = await native(f.controller);
  n.handle(async () => new Promise(() => {}));
  await expect(f.controller.request("status", undefined, 20)).rejects.toThrow("unavailable");
  await expect(f.controller.request("status", undefined, 20)).rejects.toThrow("unavailable");
  await expect(native(f.controller)).rejects.toThrow();
});

test.each(["peer-loss", "proof-revoked"])(
  "%s retires one listener and calls cleanup once, preserving uncertain claim",
  async (mode) => {
    const retired = vi.fn(async () => {});
    const f = await fixture(undefined, retired);
    const n = await native(f.controller);
    f.controller.select(sessionId);
    n.handle(async () => {
      await n.callback("claim", { sessionId, messageId, text });
      if (mode === "peer-loss") n.peer.close();
      else f.check.mockResolvedValue(false);
      return { outcome: "unconfirmed", messageId };
    });
    await expect(f.controller.request("send", { messageId, text })).rejects.toThrow();
    await vi.waitFor(() => expect(retired).toHaveBeenCalledOnce());
    await expect(fetch(f.controller.endpoint.replace("ws:", "http:"))).rejects.toThrow();
    await f.controller.close();
    await f.controller.close();
    expect(retired).toHaveBeenCalledOnce();
    const cold = await fixture(f.receiptsPath);
    cold.controller.select(sessionId);
    expect(cold.controller.pending()).toMatchObject({ messageId });
  },
);

test("pending-admission close and cleanup rejection retire owned resources without unhandled promises", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pending-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const onRetire = vi.fn(async () => {
    throw new Error("fixture cleanup failure");
  });
  const controller = await createOpenCodeController({
    receiptsPath: join(directory, "receipts.json"),
    timeoutMs: 30,
    onRetire,
  });
  cleanups.push(() => controller.close().catch(() => {}));
  const n = await native(controller);
  n.peer.close();
  await vi.waitFor(() => expect(onRetire).toHaveBeenCalledOnce());
  await expect(fetch(controller.endpoint.replace("ws:", "http:"))).rejects.toThrow();
  await expect(controller.close()).rejects.toThrow("fixture cleanup failure");
  await expect(controller.close()).rejects.toThrow("fixture cleanup failure");
  expect(onRetire).toHaveBeenCalledOnce();
});
