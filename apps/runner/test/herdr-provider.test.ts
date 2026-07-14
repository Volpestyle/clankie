import { describe, expect, it, vi } from "vitest";
import {
  HerdrTerminalError,
  HerdrTerminalProvider,
  type HerdrAttachChunk,
  type HerdrAttachment,
  type HerdrPaneSummary,
  type HerdrTransport,
  type HerdrVisibleState,
} from "../src/herdr-provider.ts";

const encoded = (text: string): string => Buffer.from(text).toString("base64");

class AsyncChunkQueue implements AsyncIterable<HerdrAttachChunk> {
  private readonly chunks: HerdrAttachChunk[] = [];
  private readonly wakes: Array<() => void> = [];
  private ended = false;

  public push(chunk: HerdrAttachChunk): void {
    this.chunks.push(chunk);
    this.wake();
  }

  public close(): void {
    this.ended = true;
    this.wake();
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<HerdrAttachChunk> {
    for (;;) {
      const chunk = this.chunks.shift();
      if (chunk) yield chunk;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => this.wakes.push(resolve));
    }
  }

  private wake(): void {
    for (const wake of this.wakes.splice(0)) wake();
  }
}

class FakeHerdrTransport implements HerdrTransport {
  public panes: HerdrPaneSummary[] = [];
  public visible = new Map<string, string>();
  public readonly attachments = new Map<string, AsyncChunkQueue>();
  public readonly inputs: Array<{ paneId: string; text: string }> = [];
  public onRead: ((paneId: string, count: number) => void) | undefined;
  private reads = 0;

  public listPanes(): Promise<HerdrPaneSummary[]> {
    return Promise.resolve(structuredClone(this.panes));
  }

  public readVisible(paneId: string): Promise<HerdrVisibleState> {
    this.reads += 1;
    this.onRead?.(paneId, this.reads);
    return Promise.resolve({ paneId, ansi: this.visible.get(paneId) ?? "", truncated: false });
  }

  public attachPane(paneId: string, signal: AbortSignal): Promise<HerdrAttachment> {
    const queue = new AsyncChunkQueue();
    this.attachments.set(paneId, queue);
    signal.addEventListener("abort", () => queue.close(), { once: true });
    return Promise.resolve({ stream: queue, close: () => queue.close() });
  }

  public sendInput(paneId: string, text: string): Promise<void> {
    this.inputs.push({ paneId, text });
    return Promise.resolve();
  }

  public emit(paneId: string, sequence: number, text: string): void {
    const queue = this.attachments.get(paneId);
    if (!queue) throw new Error(`No fake attachment for ${paneId}`);
    queue.push({ paneId, sequence, data: encoded(text) });
  }

  public disconnect(paneId: string): void {
    this.attachments.get(paneId)?.close();
  }
}

async function waitForSequence(provider: HerdrTerminalProvider, terminalId: string, sequence: number) {
  await vi.waitFor(() =>
    expect(provider.observation(terminalId).lastSequence).toBeGreaterThanOrEqual(sequence),
  );
  await provider.whenIdle(terminalId);
}

async function framesThrough(provider: HerdrTerminalProvider, terminalId: string, sequence: number) {
  const frames = [];
  for await (const frame of provider.observe(terminalId, 0)) {
    frames.push(frame);
    if (frame.sequence >= sequence) break;
  }
  return frames;
}

describe("Herdr terminal source adapter", () => {
  it("discovers multiple panes by stable terminal identity without exporting Herdr-private identity", async () => {
    const transport = new FakeHerdrTransport();
    transport.panes = [
      { paneId: "compact-1", terminalId: "01JSTABLEA", title: "editor" },
      { paneId: "compact-2", terminalId: "01JSTABLEB", title: "logs" },
      {
        paneId: "compact-secret",
        terminalId: "01JSTABLEC",
        title: "socket=/tmp/herdr/private.sock pane_id=compact-secret session:private-session",
      },
    ];
    const provider = new HerdrTerminalProvider({ transport, settleSeed: () => Promise.resolve() });

    const sessions = await provider.listSessions();

    expect(sessions.map(({ id }) => id)).toEqual(["01JSTABLEA", "01JSTABLEB", "01JSTABLEC"]);
    expect(sessions.map(({ title }) => title)).toEqual(["editor", "logs", "Herdr pane"]);
    expect(sessions.every(({ provider }) => provider === "herdr")).toBe(true);
    expect(JSON.stringify(sessions)).not.toContain("compact-");
    expect(JSON.stringify(sessions)).not.toContain("/tmp/herdr");
    expect(JSON.stringify(sessions)).not.toContain("private-session");
    expect(provider.capabilities("01JSTABLEA")).toEqual({
      observe: true,
      resume: true,
      vtRestoreSnapshot: true,
      controlLease: false,
      input: false,
      resize: false,
    });
  });

  it("seeds visible Unicode/alternate-screen state and appends burst output exactly once", async () => {
    const transport = new FakeHerdrTransport();
    transport.panes = [{ paneId: "p1", terminalId: "01JUNICODE", title: "tui" }];
    transport.visible.set("p1", "\u001b[?1049h界🙂\r\n");
    const provider = new HerdrTerminalProvider({ transport, settleSeed: () => Promise.resolve() });
    await provider.refresh();
    await vi.waitFor(() => expect(transport.attachments.has("p1")).toBe(true));
    await waitForSequence(provider, "01JUNICODE", 1);

    transport.emit("p1", 1, "burst-a");
    transport.emit("p1", 2, "-b\u001b[?1049l");
    await waitForSequence(provider, "01JUNICODE", 3);
    const frames = await framesThrough(provider, "01JUNICODE", 3);
    const output = Buffer.concat(
      frames.filter((frame) => frame.type === "output").map((frame) => Buffer.from(frame.data, "base64")),
    ).toString();

    expect(output).toBe("\u001b[?1049h界🙂\r\nburst-a-b\u001b[?1049l");
    expect(frames.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
  });

  it("retries an active seed seam and drops only attach bytes already represented by the seed", async () => {
    const transport = new FakeHerdrTransport();
    transport.panes = [{ paneId: "p2", terminalId: "01JSEAM", title: "shell" }];
    transport.visible.set("p2", "before");
    transport.onRead = (paneId, count) => {
      if (count === 2) {
        transport.visible.set(paneId, "before-during");
        transport.emit(paneId, 1, "-during");
      }
    };
    const provider = new HerdrTerminalProvider({ transport, settleSeed: () => Promise.resolve() });
    await provider.refresh();
    await waitForSequence(provider, "01JSEAM", 1);
    transport.emit("p2", 2, "-after");
    await waitForSequence(provider, "01JSEAM", 2);

    const frames = await framesThrough(provider, "01JSEAM", 2);
    const text = Buffer.concat(
      frames.filter((frame) => frame.type === "output").map((frame) => Buffer.from(frame.data, "base64")),
    ).toString();
    expect(text).toBe("before-during-after");
  });

  it("requires an active lease for input and never advertises control for read-only panes", async () => {
    const transport = new FakeHerdrTransport();
    transport.panes = [
      { paneId: "read", terminalId: "01JREADONLY", title: "read" },
      { paneId: "owned", terminalId: "01JCONTROL", title: "owned" },
    ];
    const provider = new HerdrTerminalProvider({
      transport,
      settleSeed: () => Promise.resolve(),
      canControl: ({ paneId }) => paneId === "owned",
    });
    await provider.refresh();

    await expect(provider.acquireControl("01JREADONLY", "operator")).rejects.toMatchObject({
      code: "control_unavailable",
    });
    await expect(provider.sendInput("01JCONTROL", "forged", Buffer.from("no"))).rejects.toThrow(
      "valid control lease",
    );
    const lease = await provider.acquireControl("01JCONTROL", "operator");
    await provider.sendInput("01JCONTROL", lease.id, Buffer.from("λ🙂"));
    await expect(provider.sendInput("01JCONTROL", lease.id, Uint8Array.of(0xff))).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(transport.inputs).toEqual([{ paneId: "owned", text: "λ🙂" }]);
  });

  it("emits typed closure on sequence discontinuity and deterministically resets on reattach", async () => {
    const transport = new FakeHerdrTransport();
    transport.panes = [{ paneId: "old", terminalId: "01JRESTART", title: "worker" }];
    const provider = new HerdrTerminalProvider({ transport, settleSeed: () => Promise.resolve() });
    await provider.refresh();
    await vi.waitFor(() => expect(transport.attachments.has("old")).toBe(true));
    transport.emit("old", 2, "gap");
    await vi.waitFor(() => expect(provider.observation("01JRESTART").closure).not.toBeNull());
    await provider.whenIdle("01JRESTART");
    const closed = await framesThrough(
      provider,
      "01JRESTART",
      provider.observation("01JRESTART").lastSequence,
    );
    expect(closed.at(-1)).toMatchObject({ type: "closed" });
    expect(provider.observation("01JRESTART").closure?.reason).toBe("sequence_discontinuity");

    transport.panes = [{ paneId: "new", terminalId: "01JRESTART", title: "worker" }];
    await provider.refresh();
    expect(provider.observation("01JRESTART")).toMatchObject({
      source: "herdr",
      lastSequence: 0,
      closure: null,
    });
    expect(provider.resumeDisposition("01JRESTART", 1)).toBe("unavailable");
  });

  it("maps pane disappearance and attach disconnect to typed terminal closure", async () => {
    const transport = new FakeHerdrTransport();
    transport.panes = [{ paneId: "p3", terminalId: "01JCLOSE", title: "worker" }];
    const provider = new HerdrTerminalProvider({ transport, settleSeed: () => Promise.resolve() });
    await provider.refresh();
    transport.panes = [];
    await provider.refresh();
    await provider.whenIdle("01JCLOSE");
    expect(provider.observation("01JCLOSE")).toMatchObject({ closure: { reason: "terminated" } });

    transport.panes = [{ paneId: "p4", terminalId: "01JLOST", title: "worker" }];
    await provider.refresh();
    await vi.waitFor(() => expect(transport.attachments.has("p4")).toBe(true));
    transport.disconnect("p4");
    await vi.waitFor(() => expect(provider.observation("01JLOST").closure).not.toBeNull());
    expect(provider.observation("01JLOST").closure?.reason).toBe("transport_lost");
  });

  it("rebuilds stable discovery at a reset boundary after runner restart", async () => {
    const transport = new FakeHerdrTransport();
    transport.panes = [{ paneId: "restart-pane", terminalId: "01JPROCESS", title: "worker" }];
    transport.visible.set("restart-pane", "restored");
    const before = new HerdrTerminalProvider({ transport, settleSeed: () => Promise.resolve() });
    const beforeSessions = await before.listSessions();
    await waitForSequence(before, "01JPROCESS", 1);

    const after = new HerdrTerminalProvider({ transport, settleSeed: () => Promise.resolve() });
    const afterSessions = await after.listSessions();

    expect(afterSessions.map(({ id }) => id)).toEqual(beforeSessions.map(({ id }) => id));
    expect(after.resumeDisposition("01JPROCESS", 1)).toBe("unavailable");
    expect(after.observation("01JPROCESS").lastSequence).toBe(0);
  });

  it("uses redacted typed errors for unstable or truncated protocol state", async () => {
    const transport = new FakeHerdrTransport();
    transport.panes = [{ paneId: "secret-pane", terminalId: "01JFAIL", title: "secret" }];
    transport.onRead = (paneId, count) => transport.visible.set(paneId, String(count));
    const provider = new HerdrTerminalProvider({
      transport,
      maxSeedAttempts: 1,
      settleSeed: () => Promise.resolve(),
    });
    await provider.refresh();
    await vi.waitFor(() => expect(provider.observation("01JFAIL").closure).not.toBeNull());
    const error = new HerdrTerminalError("seed_unstable", true);
    expect(error.message).not.toContain("secret-pane");
    expect(error).toMatchObject({ code: "seed_unstable", retryable: true });
  });
});
