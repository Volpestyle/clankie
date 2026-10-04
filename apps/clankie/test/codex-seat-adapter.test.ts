import { describe, expect, it, vi } from "vitest";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import type { CodexAppServerSeat, CodexSeatEvent } from "../src/captain/codex-app-server.ts";

function fixture(nativePolicy?: NonNullable<Parameters<typeof createCodexSeatAdapter>[0]>["nativePolicy"]) {
  let event: (event: CodexSeatEvent) => void = () => undefined;
  const emit = (method: string, params: Record<string, unknown> = {}) =>
    event({ method, params: { threadId: "thread-1", ...params } });
  const send = vi.fn<CodexAppServerSeat["send"]>(async () => {
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
  const trackerOverrides = vi.fn(async () => ["mcp_servers.linear.enabled=false"]);
  const adapter = createCodexSeatAdapter({
    start,
    herdr,
    trackerOverrides,
    ...(nativePolicy ? { nativePolicy } : {}),
  });
  const view = { paneId: "w1:p1", run: vi.fn(async () => undefined) };
  return { adapter, emit, start, send, close, herdr, view, trackerOverrides };
}

describe("Codex harness seat adapter", () => {
  it("binds the reported native session before its first brief, and closes on binding failure", async () => {
    const f = fixture();
    const bound = vi.fn(async (ref) => {
      expect(ref).toEqual({ harness: "codex", paneId: "w1:p1", sessionId: "thread-1" });
      expect(f.herdr).toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      throw new Error("process replaced");
    });
    expect(
      await f.adapter.start({ harness: "codex", cwd: "/scratch", brief: "first" }, { ...f.view, bound }),
    ).toMatchObject({ outcome: "failed", detail: expect.stringContaining("process replaced") });
    expect(bound).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("overrides only Clankie's required flag for a dedicated remote server and its view", async () => {
    const f = fixture();
    const inherited = ["mcp_servers.clankie.required=true", "mcp_servers.other.required=true"];
    const adapter = createCodexSeatAdapter({
      start: f.start,
      herdr: f.herdr,
      trackerOverrides: async () => [...inherited],
      serverForView: () => async () => {
        throw new Error("fixture");
      },
    });
    const started = await adapter.start({ harness: "codex", cwd: "/scratch", brief: "" }, f.view);
    expect(started.outcome).toBe("started");
    expect(f.start.mock.calls[0]![0].config).toEqual([
      ...inherited,
      "mcp_servers.clankie.required=false",
      'mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES="[]"',
    ]);
    if (started.outcome === "started") await started.control.close();
    const ordinary = createCodexSeatAdapter({
      start: f.start,
      herdr: f.herdr,
      trackerOverrides: async () => [...inherited],
    });
    const local = await ordinary.start({ harness: "codex", cwd: "/scratch", brief: "" }, f.view);
    expect(f.start.mock.calls.at(-1)![0].config).toEqual(inherited);
    if (local.outcome === "started") await local.control.close();
  });

  it("passes a deny-only expected catalog to the dedicated server and rejects a changed binding", async () => {
    const f = fixture();
    const adapter = createCodexSeatAdapter({
      start: f.start,
      herdr: f.herdr,
      trackerOverrides: async () => [],
      serverForView: () => async () => {
        throw new Error("fixture");
      },
    });
    const result = await adapter.start(
      { harness: "codex", cwd: "/scratch", brief: "first" },
      {
        ...f.view,
        expectedToolNames: ["linear_get_issue"],
        bound: async () => ({ expectedToolNames: ["linear_get_team"] }),
      },
    );
    expect(result).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("granted tools changed"),
    });
    expect(f.start.mock.calls[0]![0].config).toContain(
      `mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES=${JSON.stringify(JSON.stringify(["linear_get_issue"]))}`,
    );
    expect(f.send).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

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

  it("switches off inherited Linear connectors so writes go through Clankie's account", async () => {
    const f = fixture();
    const started = await f.adapter.start(
      {
        harness: "codex",
        cwd: "/scratch",
        brief: "",
        resumeSessionId: "thread-1",
        env: { CODEX_HOME: "/h" },
      },
      f.view,
    );
    expect(started.outcome).toBe("started");
    expect(f.trackerOverrides).toHaveBeenCalledWith("/scratch", { CODEX_HOME: "/h" });
    expect(f.start).toHaveBeenCalledWith(
      expect.objectContaining({ config: ["mcp_servers.linear.enabled=false"] }),
    );
    if (started.outcome === "started") await started.control.close();
  });

  it("does not start a hire whose inherited connectors cannot be read", async () => {
    const f = fixture();
    f.trackerOverrides.mockRejectedValueOnce(new Error("Could not read Codex's MCP servers"));
    const started = await f.adapter.start({ harness: "codex", cwd: "/scratch", brief: "go" }, f.view);
    expect(started).toMatchObject({ outcome: "failed", detail: expect.stringContaining("MCP servers") });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("refuses native startup when the source changes during connector lookup", async () => {
    const f = fixture();
    let authorized = true;
    f.trackerOverrides.mockImplementationOnce(async () => {
      authorized = false;
      return [];
    });
    const result = await f.adapter.start(
      { harness: "codex", cwd: "/scratch", brief: "never dispatch" },
      {
        ...f.view,
        guard: async () => {
          if (!authorized) throw new Error("source grant revoked");
        },
      },
    );
    expect(result).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("source grant revoked"),
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses the initial brief when source authority changes during native reporting", async () => {
    const f = fixture();
    let authorized = true;
    f.herdr.mockImplementation(async () => {
      authorized = false;
    });
    const result = await f.adapter.start(
      { harness: "codex", cwd: "/scratch", brief: "never dispatch" },
      {
        ...f.view,
        guard: async () => {
          if (!authorized) throw new Error("source grant revoked");
        },
      },
    );
    expect(result).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("source grant revoked"),
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("forwards the original source guard only for the initial brief", async () => {
    const f = fixture();
    const guard = vi.fn(async () => undefined);
    const started = await f.adapter.start(
      { harness: "codex", cwd: "/scratch", brief: "original brief" },
      { ...f.view, guard },
    );
    if (started.outcome !== "started") throw new Error(started.detail);
    try {
      expect(f.send).toHaveBeenCalledExactlyOnceWith("original brief", guard);
      guard.mockRejectedValue(new Error("original turn ended"));
      expect(await started.control.send("fresh owner message")).toMatchObject({ outcome: "accepted" });
      expect(f.send).toHaveBeenLastCalledWith("fresh owner message");
    } finally {
      await started.control.close();
    }
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
      f.send.mockResolvedValueOnce({ turnId: "turn-1", state: "steered" });
      expect(await started.control.send("follow-up")).toMatchObject({
        outcome: "accepted",
        messageId: "turn-1",
        state: "steered",
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

it("returns pending without teardown, then registers and briefs the same seat once review finishes", async () => {
  const f = fixture();
  const realStart = f.start.getMockImplementation()!;
  let finishReview!: () => void;
  const review = new Promise<void>((resolve) => {
    finishReview = resolve;
  });
  f.start.mockImplementationOnce(async (options) => {
    options.onThreadPending();
    await review;
    return realStart(options);
  });
  const result = await f.adapter.start(
    { harness: "codex", cwd: "/scratch", brief: "original brief" },
    f.view,
  );
  expect(result).toMatchObject({ outcome: "failed", detail: expect.stringContaining("do not retry") });
  expect(f.send).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
  finishReview();
  const ref = { harness: "codex" as const, paneId: f.view.paneId, sessionId: "thread-1" };
  await vi.waitFor(async () => expect(await f.adapter.attach(ref)).toBeDefined());
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledExactlyOnceWith("original brief");
  await (await f.adapter.attach(ref))!.close();
});

it("cancels pending startup when its native pane closes", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let signal: AbortSignal | undefined;
  f.start.mockImplementationOnce(async (options) => {
    signal = options.signal;
    await options.startView([]);
    options.onThreadPending();
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(options.signal.reason)),
    );
  });
  try {
    await f.adapter.start({ harness: "codex", cwd: "/scratch", brief: "never send" }, f.view);
    f.herdr.mockRejectedValueOnce(new Error("pane_not_found"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(signal?.aborted).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
    vi.useRealTimers();
  }
});

it("passes the exact native view and launch to the trusted policy factory", async () => {
  const policy = {
    connected: async () => {},
    beforeTurn: async () => {},
    audit: async () => {},
    failed: async () => {},
  };
  const factory = vi.fn(() => policy);
  const f = fixture(factory);
  const launch = { harness: "codex" as const, cwd: "/owned/task", brief: "" };
  const result = await f.adapter.start(launch, f.view);
  expect(factory).toHaveBeenCalledWith(launch, f.view);
  expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ policy }));
  if (result.outcome === "started") await result.control.close();
});
