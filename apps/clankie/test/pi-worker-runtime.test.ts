import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createPiWorkerRuntime, PI_WORKER_MESSAGE } from "../../../integrations/pi-plugin/worker-runtime.mjs";

function fixture() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sessionId = randomUUID();
  let idle = true;
  let trusted = true;
  let pending = false;
  const entries: any[] = [];
  const signal = new AbortController();
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/workspace",
    model: { provider: "native", id: "model" },
    thinkingLevel: "high",
    signal: signal.signal,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/native/${sessionId}.jsonl`,
      getSessionDir: () => "/native",
      getHeader: () => ({ type: "session", version: 3, id: sessionId, cwd: "/workspace" }),
      getBranch: () => entries,
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    isProjectTrusted: () => trusted,
    ui: { getEditorText: () => "owner's unsent draft", setEditorText: vi.fn() },
    abort: vi.fn(),
    shutdown: vi.fn(),
  };
  const emit = (name: string, event = {}, context = ctx) => handlers.get(name)?.(event, context);
  const controller = {
    connected: () => true,
    authorize: vi.fn(async (_action: string) => {}),
    claim: vi.fn(async (_claim: unknown) => {}),
    receipt: vi.fn(async (_receipt: unknown) => {}),
    close: vi.fn(),
  };
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    sendMessage: vi.fn((message: any, _options: any) => {
      idle = false;
      emit("message_start", { message: { ...message, role: "custom" } });
      entries.push({ type: "custom_message", ...message });
    }),
    sendUserMessage: vi.fn(),
  };
  const runtime = createPiWorkerRuntime(pi, controller);
  const start = async () => {
    emit("session_start", { reason: "startup" });
    await runtime.initialize({ cwd: "/workspace", model: "native/model", effort: "high" });
  };
  const send = (extra = {}) =>
    runtime.send({ messageId: randomUUID(), text: "same visible brief", timeoutMs: 15, ...extra });
  const finish = (stopReason = "stop") => {
    entries.push({
      type: "message",
      message: { role: "assistant", stopReason, content: [{ type: "text", text: "Native final answer" }] },
    });
    idle = true;
    emit("agent_settled");
  };
  return {
    runtime,
    pi,
    controller,
    ctx,
    emit,
    start,
    send,
    finish,
    entries,
    sessionId,
    signal,
    idle: (value: boolean) => {
      idle = value;
    },
    trusted: (value: boolean) => {
      trusted = value;
    },
    pending: (value: boolean) => {
      pending = value;
    },
    handlers,
  };
}

describe("native Pi extension delivery", () => {
  test("supported custom metadata correlates native event without changing visible text or draft", async () => {
    const f = fixture();
    await f.start();
    const result = await f.send();
    expect(result.outcome).toBe("accepted");
    expect(f.pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: PI_WORKER_MESSAGE,
        content: "same visible brief",
        display: true,
        details: { requestId: result.messageId, sessionId: f.sessionId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.ctx.ui.getEditorText()).toBe("owner's unsent draft");
    expect(f.ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(f.controller.receipt).toHaveBeenCalledWith({
      sessionId: f.sessionId,
      messageId: result.messageId,
      outcome: "accepted",
    });
  });

  test("native busy followUp and steer select actual native queue primitives", async () => {
    for (const deliverAs of ["followUp", "steer"]) {
      const f = fixture();
      await f.start();
      f.idle(false);
      const result = await f.send({ deliverAs });
      expect(result.outcome).toBe("accepted");
      expect(f.pi.sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true, deliverAs });
    }
  });

  test("void return / memory queue insertion is not a receipt", async () => {
    const f = fixture();
    await f.start();
    f.idle(false);
    f.pi.sendMessage.mockImplementation(() => {});
    const result = await f.send();
    expect(result.outcome).toBe("unconfirmed");
    expect(f.controller.receipt).not.toHaveBeenCalled();
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("equal owner text and transformed native content never acknowledge the request", async () => {
    for (const transformed of [false, true]) {
      const f = fixture();
      await f.start();
      f.pi.sendMessage.mockImplementation((message) => {
        f.emit("message_start", {
          message: transformed
            ? { ...message, role: "custom", content: "transformed" }
            : { role: "user", content: [{ type: "text", text: message.content }] },
        });
      });
      expect((await f.send()).outcome).toBe("unconfirmed");
      expect(f.controller.receipt).not.toHaveBeenCalled();
      expect(f.handlers.has("input")).toBe(false);
    }
  });

  test("native asynchronous error without a correlated event remains uncertain", async () => {
    const f = fixture();
    await f.start();
    f.pi.sendMessage.mockImplementation(() => {
      queueMicrotask(() => f.emit("agent_settled"));
    });
    const result = await f.send();
    expect(result.outcome).toBe("unconfirmed");
    expect(await f.runtime.settlement({ messageId: result.messageId })).toEqual({ state: "pending" });
  });

  test("held claim then session replacement cannot invoke native send", async () => {
    const f = fixture();
    await f.start();
    let release!: () => void;
    f.controller.claim.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const result = f.send();
    await vi.waitFor(() => expect(f.controller.claim).toHaveBeenCalled());
    f.emit("session_before_switch", { reason: "new" });
    release();
    expect((await result).outcome).toBe("unavailable");
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.ctx.shutdown).not.toHaveBeenCalled();
  });

  test("session replacement after native invocation preserves uncertainty", async () => {
    const f = fixture();
    await f.start();
    f.pi.sendMessage.mockImplementation(() => {
      f.emit("session_before_switch", { reason: "resume" });
    });
    expect((await f.send()).outcome).toBe("unconfirmed");
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.controller.receipt).not.toHaveBeenCalled();
  });

  test("lost acknowledgement is uncertain even after correlated native message event", async () => {
    const f = fixture();
    await f.start();
    f.controller.receipt.mockRejectedValue(new Error("lost transport"));
    expect((await f.send()).outcome).toBe("unconfirmed");
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("nested dialogs and revoked project trust refuse dispatch without modifying owner choices", async () => {
    const f = fixture();
    await f.start();
    f.emit("ui_prompt_start", { kind: "confirm", title: "Approve?" });
    f.emit("ui_prompt_start", { kind: "confirm", title: "Approve?" });
    f.emit("ui_prompt_end", { kind: "confirm", title: "Approve?" });
    expect(await f.runtime.status()).toBe("blocked");
    expect((await f.send()).outcome).toBe("unavailable");
    f.emit("ui_prompt_end", { kind: "confirm", title: "Approve?" });
    f.trusted(false);
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.controller.claim).not.toHaveBeenCalled();
  });

  test("dialog arriving while durable claim is held prevents invocation", async () => {
    const f = fixture();
    await f.start();
    f.controller.claim.mockImplementation(async () => {
      f.emit("ui_prompt_start", { kind: "custom" });
    });
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.controller.receipt).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not-sent" }));
  });

  test("RPC hasUI is insufficient and reloading permanently retires original control", async () => {
    const f = fixture();
    f.ctx.mode = "rpc";
    await expect(f.start()).rejects.toThrow();
    const g = fixture();
    await g.start();
    g.emit("session_start", { reason: "reload" });
    await expect(g.runtime.status()).rejects.toThrow();
    expect(g.ctx.shutdown).not.toHaveBeenCalled();
  });

  test("settled reads actual native branch only after matching message and final native settlement", async () => {
    const f = fixture();
    await f.start();
    const result = await f.send();
    f.idle(true);
    expect(await f.runtime.settlement({ messageId: result.messageId })).toEqual({ state: "pending" });
    f.finish();
    expect(await f.runtime.settlement({ messageId: result.messageId })).toEqual({
      state: "completed",
      ok: true,
      text: "Native final answer",
      stopReason: "stop",
    });
    expect(await f.runtime.settlement({ messageId: randomUUID() })).toEqual({ state: "pending" });
  });

  test("other native input makes later output attribution unavailable", async () => {
    const f = fixture();
    await f.start();
    const result = await f.send();
    f.emit("message_start", { message: { role: "user", content: "owner follow-up" } });
    f.finish();
    expect(await f.runtime.settlement({ messageId: result.messageId })).toEqual({ state: "pending" });
  });

  test("owner input arriving during final-history authorization prevents stale completion", async () => {
    const f = fixture();
    await f.start();
    const result = await f.send();
    f.finish();
    f.controller.authorize.mockImplementation(async (action) => {
      if (action === "history")
        f.emit("message_start", { message: { role: "user", content: "new owner input" } });
    });
    expect(await f.runtime.settlement({ messageId: result.messageId })).toEqual({ state: "pending" });
  });

  test("compaction or retry without an active native run signal cannot receive custom dispatch", async () => {
    const f = fixture();
    await f.start();
    f.idle(false);
    f.signal.abort();
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.controller.receipt).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not-sent" }));
  });

  test("abort and errors are not successful completion just because Pi is idle", async () => {
    for (const reason of ["error", "aborted", "length"]) {
      const f = fixture();
      await f.start();
      const result = await f.send();
      f.finish(reason);
      expect(await f.runtime.settlement({ messageId: result.messageId })).toEqual(
        expect.objectContaining({ ok: false, stopReason: reason }),
      );
    }
  });

  test("native abort must observe aborted signal and subsequent settled; void is insufficient", async () => {
    const f = fixture();
    await f.start();
    f.idle(false);
    expect(await f.runtime.interrupt({ timeoutMs: 5 })).toBe(false);
    expect(f.ctx.abort).toHaveBeenCalledTimes(1);
    f.ctx.abort.mockImplementation(() => {
      f.signal.abort();
      f.finish("aborted");
    });
    expect(await f.runtime.interrupt({ timeoutMs: 15 })).toBe(true);
  });

  test("close releases listeners and control without touching owner process, draft or turn", async () => {
    const f = fixture();
    await f.start();
    f.idle(false);
    f.runtime.close();
    expect(f.handlers.size).toBe(0);
    expect(f.controller.close).toHaveBeenCalledOnce();
    expect(f.ctx.abort).not.toHaveBeenCalled();
    expect(f.ctx.shutdown).not.toHaveBeenCalled();
    expect(f.ctx.ui.setEditorText).not.toHaveBeenCalled();
    await expect(f.runtime.status()).rejects.toThrow();
  });
});
