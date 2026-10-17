import { expect, test, vi } from "vitest";
// @ts-expect-error standalone native plugin ESM.
import plugin from "../../../integrations/opencode-plugin/plugin.mjs";

const id = "ses_readiness1234";
type Hooks = {
  dispose(): Promise<void>;
  event(input: {
    event: { type: string; properties: { info: { id: string; parentID?: string } } };
  }): Promise<void>;
  "experimental.chat.system.transform"(
    input: { sessionID: string },
    output: { system: string[] },
  ): Promise<void>;
};

async function fixture(
  options: {
    resume?: boolean;
    nativeId?: string;
    contextFailure?: boolean;
    emptyContext?: boolean;
    contextWait?: Promise<void>;
  },
  run: (state: {
    hooks: Hooks;
    order: string[];
    prompt: ReturnType<typeof vi.fn>;
    systems: string[];
  }) => Promise<void>,
) {
  vi.useFakeTimers();
  vi.stubEnv("CLANKIE_OPENCODE_BRIDGE", "http://127.0.0.1:32100");
  vi.stubEnv("CLANKIE_OPENCODE_BRIDGE_TOKEN", "fixture");
  vi.stubEnv("CLANKIE_OPENCODE_SESSION", options.resume ? id : "");
  const order: string[] = [],
    systems: string[] = [];
  let contextCalls = 0,
    polled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const action = new URL(input).pathname.slice(1);
      order.push(action);
      if (action === "context") {
        await options.contextWait;
        contextCalls++;
        return Response.json(
          { text: options.emptyContext ? "" : `identity/memory ${contextCalls}` },
          { status: options.contextFailure ? 503 : 200 },
        );
      }
      if (action === "poll" && !polled) {
        polled = true;
        return Response.json({ event: { id: "wake1", content: "wake" } });
      }
      return Response.json({});
    }),
  );
  let hooks: Hooks | undefined;
  const prompt = vi.fn(async () => {
    order.push("native-prompt");
    const output = { system: [] as string[] };
    await hooks!["experimental.chat.system.transform"]({ sessionID: id }, output);
    systems.push(...output.system);
  });
  const client = {
    session: {
      get: vi.fn(async () => {
        order.push("native-get");
        return { data: { id: options.nativeId ?? id } };
      }),
      status: vi.fn(async () => ({ data: { [id]: { type: "idle" } } })),
      promptAsync: prompt,
    },
    tui: { showToast: vi.fn(async () => {}) },
  };
  try {
    hooks = await plugin({ client });
    await run({ hooks: hooks!, order, prompt, systems });
  } finally {
    await hooks?.dispose();
    await vi.advanceTimersByTimeAsync(500);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
}

test.each([true, false])(
  "%s resume readiness arms an exact idle session without a bootstrap turn",
  async (resume) => {
    await fixture({ resume }, async ({ hooks, order, prompt, systems }) => {
      if (resume) await vi.advanceTimersByTimeAsync(0);
      else await hooks.event({ event: { type: "session.created", properties: { info: { id } } } });
      expect(order).toEqual(["native-get", "bind", "context", "ready"]);
      expect(prompt).not.toHaveBeenCalled();
      // The first event can be a native wake, without an owner prompt. Its real
      // system hook reads a fresh card rather than reusing the preflight text.
      await vi.advanceTimersByTimeAsync(500);
      expect(prompt).toHaveBeenCalledOnce();
      expect(systems).toEqual(["identity/memory 2"]);
      expect(order.indexOf("ready")).toBeLessThan(order.indexOf("poll"));
      expect(order.indexOf("claim")).toBeLessThan(order.indexOf("native-prompt"));
    });
  },
);

test("readiness fails closed and stops the seat for a mismatched native identity", async () => {
  await fixture({ nativeId: "ses_other12345", resume: true }, async ({ hooks, order, prompt }) => {
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toContain("failure");
    expect(order).not.toContain("ready");
    expect(order).not.toContain("poll");
    expect(prompt).not.toHaveBeenCalled();
    await expect(
      hooks["experimental.chat.system.transform"]({ sessionID: id }, { system: [] }),
    ).rejects.toThrow("stopped");
    expect(order).not.toContain("bind");
  });
});

// VUH-2348: a context read that fails after its retries fails closed for now,
// without a model turn, but records a warning instead of stopping the seat.
test.each([{ contextFailure: true }, { emptyContext: true }])(
  "an unavailable context preflight fails closed without a model turn or a permanent stop for %j",
  async (options) => {
    await fixture({ ...options, resume: true }, async ({ hooks, order, prompt }) => {
      await vi.advanceTimersByTimeAsync(4000);
      expect(order).toContain("warning");
      expect(order).not.toContain("failure");
      expect(order).not.toContain("ready");
      expect(order).not.toContain("poll");
      expect(prompt).not.toHaveBeenCalled();
      const turn = hooks["experimental.chat.system.transform"]({ sessionID: id }, { system: [] });
      const refused = expect(turn).rejects.toThrow("context_unavailable");
      await vi.advanceTimersByTimeAsync(4000);
      await refused;
      expect(order).not.toContain("failure");
    });
  },
);

test("a session switch during preflight cannot re-arm the old session", async () => {
  let release!: () => void;
  const contextWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await fixture({ resume: true, contextWait }, async ({ hooks, order, prompt }) => {
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_other12345" } } } }),
    ).rejects.toThrow("session_switched");
    release();
    await vi.advanceTimersByTimeAsync(500);
    expect(order).not.toContain("ready");
    expect(prompt).not.toHaveBeenCalled();
  });
});
