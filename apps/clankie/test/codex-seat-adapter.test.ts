import { describe, expect, it, vi } from "vitest";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import type { CodexSeatEvent } from "../src/captain/codex-app-server.ts";

function fixture() {
  let event: (event: CodexSeatEvent) => void = () => undefined;
  const emit = (method: string, params: Record<string, unknown> = {}) =>
    event({ method, params: { threadId: "thread-1", ...params } });
  const send = vi.fn(async () => {
    emit("turn/started", { turn: { id: "turn-1" } });
    return { turnId: "turn-1", state: "started" as const };
  });
  const close = vi.fn(async () => undefined);
  const herdr = vi.fn(async () => undefined);
  const start = vi.fn(async (options) => {
    event = options.onEvent;
    await options.startView(["--remote", "unix:///owned/socket"]);
    return {
      threadId: "thread-1",
      viewArgs: ["--remote", "unix:///owned/socket", "resume", "thread-1"],
      send,
      close,
      interrupt: vi.fn(async () => true),
    };
  });
  const adapter = createCodexSeatAdapter({ start, herdr });
  const view = { paneId: "w1:p1", run: vi.fn(async () => undefined) };
  return { adapter, emit, start, send, close, herdr, view };
}

describe("Codex harness seat adapter", () => {
  it("resumes the exact existing thread without creating or prompting a fresh session", async () => {
    const f = fixture();
    const started = await f.adapter.start(
      { harness: "codex", cwd: "/scratch", brief: "", resumeSessionId: "thread-1" },
      f.view,
    );
    expect(started.outcome).toBe("started");
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ resumeThreadId: "thread-1" }));
    expect(f.send).not.toHaveBeenCalled();
    if (started.outcome === "started") await started.control.close();
  });

  it("refuses a different native thread before sending the brief", async () => {
    const f = fixture();
    const started = await f.adapter.start(
      { harness: "codex", cwd: "/scratch", brief: "do not send", resumeSessionId: "other-thread" },
      f.view,
    );
    expect(started).toMatchObject({ outcome: "failed", detail: expect.stringContaining("different thread") });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("hires and messages through the protocol; reports the exact session to the view", async () => {
    const f = fixture();
    const started = await f.adapter.start(
      {
        harness: "codex",
        cwd: "/scratch",
        brief: "full\nbrief",
        model: "chosen",
        effort: "high",
        env: { CODEX_HOME: "/skills" },
      },
      f.view,
    );
    expect(started.outcome).toBe("started");
    if (started.outcome !== "started") throw new Error(started.detail);
    try {
      expect(f.start).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/scratch",
          model: "chosen",
          effort: "high",
          env: { CODEX_HOME: "/skills" },
        }),
      );
      expect(f.send).toHaveBeenCalledWith("full\nbrief");
      expect(f.view.run).toHaveBeenCalledWith(["codex", "--remote", "unix:///owned/socket"]);
      expect(f.herdr).toHaveBeenCalledWith(
        expect.arrayContaining(["report-agent", "--agent-session-id", "thread-1"]),
      );
      expect(await started.control.status()).toBe("working");
      expect(await started.control.send("follow-up")).toMatchObject({
        outcome: "accepted",
        messageId: "turn-1",
      });
      expect(f.send).toHaveBeenLastCalledWith("follow-up");
      expect(await f.adapter.attach(started.control.ref)).toBe(started.control);
      expect(await f.adapter.attach({ ...started.control.ref, paneId: "other" })).toBeUndefined();
      const settled = started.control.settled();
      f.emit("turn/completed", {
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", phase: "final_answer", text: "done" }],
        },
      });
      await expect(settled).resolves.toMatchObject({ type: "turn_completed", ok: true, text: "done" });
      expect(await started.control.status()).toBe("idle");
    } finally {
      await started.control.close();
    }
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(await f.adapter.attach(started.control.ref)).toBeUndefined();
  });

  it.each(["failed", "interrupted"])("does not turn %s into successful completion", async (status) => {
    const f = fixture();
    const started = await f.adapter.start({ harness: "codex", cwd: "/scratch", brief: "hello" }, f.view);
    if (started.outcome !== "started") throw new Error(started.detail);
    const settled = started.control.settled();
    f.emit("turn/completed", { turn: { id: "turn-1", status } });
    await expect(settled).resolves.toMatchObject({ ok: false, stopReason: status });
    await started.control.close();
  });

  it("exposes approval requests without approving them and aborts settlement waits", async () => {
    const f = fixture();
    const started = await f.adapter.start({ harness: "codex", cwd: "/scratch", brief: "hello" }, f.view);
    if (started.outcome !== "started") throw new Error(started.detail);
    const abort = new AbortController();
    const settled = started.control.settled(abort.signal);
    const assertion = expect(settled).rejects.toThrow("cancel wait");
    abort.abort(new Error("cancel wait"));
    await assertion;
    f.emit("item/commandExecution/requestApproval");
    expect(await started.control.status()).toBe("blocked");
    expect(await started.control.settled()).toMatchObject({ type: "blocked" });
    f.emit("thread/status/changed", { status: { type: "active", activeFlags: [] } });
    expect(await started.control.status()).toBe("working");
    await started.control.close();
  });

  it("keeps uncertain delivery explicit and closes an unverified hire", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error("delivery is uncertain"));
    const started = await f.adapter.start({ harness: "codex", cwd: "/scratch", brief: "hello" }, f.view);
    expect(started).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
      detail: expect.stringContaining("brief_delivery_unverified"),
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("does not confuse a subagent's completion with its own turn", async () => {
    const f = fixture();
    const started = await f.adapter.start({ harness: "codex", cwd: "/scratch", brief: "hello" }, f.view);
    if (started.outcome !== "started") throw new Error(started.detail);
    f.emit("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } });
    expect(await started.control.status()).toBe("working");
    f.emit("connection/closed");
    expect(await started.control.status()).toBe("offline");
    expect(await started.control.settled()).toMatchObject({ type: "exited" });
    expect(await started.control.send("do not replay")).toMatchObject({ outcome: "offline" });
    expect(f.send).toHaveBeenCalledTimes(1);
    await started.control.close();
  });

  it("closes the app-server when its owned Herdr pane disappears", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const started = await f.adapter.start({ harness: "codex", cwd: "/scratch", brief: "hello" }, f.view);
    if (started.outcome !== "started") throw new Error(started.detail);
    try {
      f.herdr.mockRejectedValue(new Error("pane_not_found"));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(await f.adapter.attach(started.control.ref)).toBeUndefined();
    } finally {
      await started.control.close();
      vi.useRealTimers();
    }
  });
});
