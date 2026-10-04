import { expect, test, vi } from "vitest";
// @ts-expect-error Native OpenCode plugins are standalone ESM.
import { createOpenCodeWorkerRuntime } from "../../../integrations/opencode-plugin/worker-runtime.mjs";

const sessionId = "ses_nativeWorker123";
const otherSession = "ses_ownerSession456";
const messageId = "msg_controllerRequest123";
const cwd = "/projects/worker";

function fixture(resume = false) {
  let route: { name: string; params?: { sessionID: string } } = resume
    ? { name: "session", params: { sessionID: sessionId } }
    : { name: "home" };
  let watch = () => {};
  let connected = true;
  const abort = new AbortController();
  const state = {
    ready: true,
    status: "idle",
    permissions: [] as { sessionID: string }[],
    questions: [] as { sessionID: string }[],
  };
  const api = {
    app: { version: "1.18.18" },
    lifecycle: { signal: abort.signal },
    route: {
      get current() {
        return route;
      },
      navigate: vi.fn((name: string, params?: { sessionID: string }) => {
        route = { name, ...(params ? { params } : {}) };
        watch();
      }),
    },
    keymap: { dispatchCommand: vi.fn(async (_name: string) => {}) },
    state: {
      config: { mcp: { clankie: { type: "local", command: ["clankie", "mcp", "--fleet"], enabled: true } } },
      get ready() {
        return state.ready;
      },
      session: {
        status: () => ({ type: state.status }),
        permission: () => state.permissions,
        question: () => state.questions,
      },
    },
    client: {
      provider: {
        list: vi.fn(async () => ({
          data: {
            all: [{ id: "fixture", models: { native: { variants: { high: {} } } } }],
            connected: ["fixture"],
          },
        })),
      },
      session: {
        create: vi.fn(async () => ({ data: { id: sessionId } })),
        get: vi.fn(async () => ({ data: { id: sessionId, directory: cwd } })),
        status: vi.fn(async () => ({
          data: state.status === "idle" ? {} : { [sessionId]: { type: state.status } },
        })),
        messages: vi.fn(async () => ({ data: [] as unknown[] })),
        promptAsync: vi.fn(async () => ({ response: { status: 204 } })),
        abort: vi.fn(async () => ({ data: true })),
      },
      permission: { list: vi.fn(async () => ({ data: state.permissions })) },
      question: { list: vi.fn(async () => ({ data: state.questions })) },
    },
  };
  const controller = {
    watchRoute: (fn: () => void) => {
      watch = fn;
      fn();
      return () => {
        watch = () => {};
      };
    },
    connected: () => connected,
    authorize: vi.fn(async (_action: string) => {}),
    claim: vi.fn(async (_claim: unknown) => {}),
    receipt: vi.fn(async (_receipt: unknown) => {}),
  };
  const runtime = createOpenCodeWorkerRuntime(api, controller);
  return {
    api,
    state,
    controller,
    runtime,
    switch: (id = otherSession) => api.route.navigate("session", { sessionID: id }),
    disconnect: () => {
      connected = false;
    },
    initialize: () => runtime.initialize({ cwd, ...(resume ? { resumeSessionId: sessionId } : {}) }),
    send: () => runtime.send({ messageId, text: "Review the diff" }),
  };
}

test("first initializer creates and observes one session before caller mounts the prompt; no repeat initialization", async () => {
  const f = fixture();
  let promptMounted = false;
  f.api.client.session.create.mockImplementation(async () => {
    expect(promptMounted).toBe(false);
    return { data: { id: sessionId } };
  });
  expect(await f.initialize()).toEqual({ sessionId, version: "1.18.18" });
  promptMounted = true;
  await expect(f.initialize()).rejects.toThrow("only once");
  expect(f.api.client.session.create).toHaveBeenCalledTimes(1);
  expect(f.api.route.navigate).toHaveBeenCalledTimes(1);
});

test("native exit authorizes the original session and refuses a route change during authorization", async () => {
  const f = fixture();
  await f.initialize();
  await f.runtime.exit();
  expect(f.controller.authorize).toHaveBeenLastCalledWith("exit");
  expect(f.api.keymap.dispatchCommand).toHaveBeenCalledExactlyOnceWith("app.exit");
  const changed = fixture();
  await changed.initialize();
  changed.controller.authorize.mockImplementation(async () => {
    changed.switch();
    changed.switch(sessionId);
  });
  await expect(changed.runtime.exit()).rejects.toThrow();
  expect(changed.api.keymap.dispatchCommand).not.toHaveBeenCalled();
});

test("exact resume never creates or navigates; wrong route and unsupported exact version refuse before effects", async () => {
  const f = fixture(true);
  await f.initialize();
  expect(f.api.client.session.create).not.toHaveBeenCalled();
  expect(f.api.route.navigate).not.toHaveBeenCalled();
  const wrong = fixture(true);
  wrong.switch();
  await expect(wrong.initialize()).rejects.toThrow("exact saved session");
  expect(wrong.api.client.session.create).not.toHaveBeenCalled();
  const version = fixture();
  version.api.app.version = "1.18.29";
  await expect(version.initialize()).rejects.toThrow("exactly 1.18.18");
  expect(version.api.client.session.create).not.toHaveBeenCalled();
});

test("route changes during create or session read cannot select, bind or submit a different session", async () => {
  const f = fixture();
  f.api.client.session.create.mockImplementation(async () => {
    f.switch();
    return { data: { id: sessionId } };
  });
  await expect(f.initialize()).rejects.toThrow("no navigation or brief");
  expect(f.api.route.navigate).toHaveBeenCalledTimes(1); // Owner only.
  const rebound = fixture(true);
  rebound.api.client.session.get.mockImplementation(async () => {
    rebound.switch();
    rebound.switch(sessionId);
    return { data: { id: sessionId, directory: cwd } };
  });
  await expect(rebound.initialize()).rejects.toThrow("not displayed after initialization");
});

test("idle dispatch uses SDKv2 exact session and message IDs after durable claim, preserving the native draft", async () => {
  const f = fixture();
  const draft = { input: "owner unsent draft", parts: [{ type: "text", text: "draft" }] };
  const before = structuredClone(draft);
  await f.initialize();
  expect(await f.send()).toEqual({ outcome: "accepted", messageId, state: "queued" });
  expect(f.api.client.session.promptAsync).toHaveBeenCalledWith(
    { sessionID: sessionId, messageID: messageId, parts: [{ type: "text", text: "Review the diff" }] },
    expect.objectContaining({ throwOnError: true }),
  );
  expect(f.controller.claim.mock.invocationCallOrder[0]).toBeLessThan(
    f.api.client.session.promptAsync.mock.invocationCallOrder[0]!,
  );
  expect(draft).toEqual(before); // The runtime has no prompt ref or mutator.
});

test.each(["busy", "permission", "question", "not-ready"])(
  "%s holds native submission without claiming or answering",
  async (kind) => {
    const f = fixture();
    await f.initialize();
    if (kind === "busy") f.state.status = "busy";
    if (kind === "permission") f.state.permissions = [{ sessionID: sessionId }];
    if (kind === "question") f.state.questions = [{ sessionID: sessionId }];
    if (kind === "not-ready") f.state.ready = false;
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.controller.claim).not.toHaveBeenCalled();
    expect(f.api.client.session.promptAsync).not.toHaveBeenCalled();
    expect(f.api.client.session.abort).not.toHaveBeenCalled();
  },
);

test.each(["authorize", "claim"])(
  "owner switches during %s: no retarget, including observed A→B→A",
  async (phase) => {
    const f = fixture();
    await f.initialize();
    const change = async () => {
      f.switch();
      f.switch(sessionId);
    };
    if (phase === "authorize") f.controller.authorize.mockImplementation(change);
    else f.controller.claim.mockImplementation(change);
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.api.client.session.promptAsync).not.toHaveBeenCalled();
    if (phase === "claim")
      expect(f.controller.receipt).toHaveBeenCalledWith({ sessionId, messageId, outcome: "not-sent" });
    expect((await f.send()).outcome).toBe("unavailable");
  },
);

test.each(["disconnect", "switch", "native-error"])(
  "%s after submission is uncertain; original claim remains and target is exact",
  async (kind) => {
    const f = fixture();
    await f.initialize();
    f.api.client.session.promptAsync.mockImplementation(async () => {
      if (kind === "disconnect") f.disconnect();
      if (kind === "switch") f.switch();
      if (kind === "native-error") throw new Error("response lost after acceptance");
      return { response: { status: 204 } };
    });
    expect((await f.send()).outcome).toBe("unconfirmed");
    expect(f.controller.receipt).not.toHaveBeenCalled();
    expect(f.api.client.session.promptAsync).toHaveBeenCalledTimes(1);
  },
);

test("a decision/busy event arriving during claim prevents submission and can acknowledge only not-sent", async () => {
  const f = fixture();
  await f.initialize();
  f.controller.claim.mockImplementation(async () => {
    f.state.questions = [{ sessionID: sessionId }];
  });
  expect((await f.send()).outcome).toBe("unavailable");
  expect(f.api.client.session.promptAsync).not.toHaveBeenCalled();
  expect(f.controller.receipt).toHaveBeenCalledWith({ sessionId, messageId, outcome: "not-sent" });
});

test("history is read-only exact-session normalized content; control close does not delete history", async () => {
  const f = fixture();
  await f.initialize();
  f.api.client.session.messages.mockResolvedValue({
    data: [
      {
        info: { id: "m1", sessionID: sessionId, role: "assistant", time: { completed: 1 } },
        parts: [
          { id: "p1", messageID: "m1", sessionID: sessionId, type: "text", text: "Done" },
          { id: "foreign", messageID: "m1", sessionID: otherSession, type: "text", text: "private" },
        ],
      },
    ],
  });
  expect(await f.runtime.history()).toEqual([{ type: "message", id: "p1:0", role: "agent", text: "Done" }]);
  f.runtime.close();
  await expect(f.runtime.history()).rejects.toThrow("unavailable");
  expect(f.api.client.session.promptAsync).not.toHaveBeenCalled();
  expect(f.api.client.session.abort).not.toHaveBeenCalled();
});

test("interrupt is exact, working-only and owner decisions remain held", async () => {
  const f = fixture();
  await f.initialize();
  expect(await f.runtime.interrupt()).toBe(false);
  f.state.status = "busy";
  f.state.permissions = [{ sessionID: sessionId }];
  expect(await f.runtime.interrupt()).toBe(false);
  f.state.permissions = [];
  expect(await f.runtime.interrupt()).toBe(true);
  expect(f.api.client.session.abort).toHaveBeenCalledWith({ sessionID: sessionId }, expect.any(Object));
});

test("model/variant selection uses the selected native provider schema, not guessed CLI flags", async () => {
  const f = fixture();
  await f.runtime.initialize({ cwd, model: "fixture/native", effort: "high" });
  await f.send();
  expect(f.api.client.session.promptAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      model: { providerID: "fixture", modelID: "native" },
      variant: "high",
    }),
    expect.anything(),
  );
  for (const selection of [
    { model: "missing/native" },
    { model: "fixture/native", effort: "imaginary" },
    { effort: "high" },
  ]) {
    const unsupported = fixture();
    await expect(unsupported.runtime.initialize({ cwd, ...selection })).rejects.toThrow();
    expect(unsupported.api.client.session.create).not.toHaveBeenCalled();
    expect(unsupported.api.client.session.promptAsync).not.toHaveBeenCalled();
  }
});

test.each(["operator", "disabled", "personal-tracker"])(
  "%s MCP projection cannot initialize delivery authority",
  async (kind) => {
    const f = fixture();
    await f.initialize();
    if (kind === "operator") f.api.state.config.mcp.clankie.command = ["clankie", "mcp", "--seat"];
    else if (kind === "disabled") f.api.state.config.mcp.clankie.enabled = false;
    else
      Object.assign(f.api.state.config.mcp, {
        personal: { type: "remote", url: "https://mcp.linear.app/mcp" },
      });
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.controller.claim).not.toHaveBeenCalled();
  },
);

test("idle is not completion: exact parent, completed timestamp and native final finish are required", async () => {
  const f = fixture();
  await f.initialize();
  const reply = {
    info: {
      id: "msg_assistantReply123",
      sessionID: sessionId,
      parentID: messageId,
      role: "assistant",
      time: { created: 1, completed: 2 },
      finish: "stop",
    },
    parts: [
      {
        id: "prt_reply123",
        type: "text",
        text: "Done",
        sessionID: sessionId,
        messageID: "msg_assistantReply123",
      },
    ],
  };
  for (const mutate of [
    (value: typeof reply) => {
      value.info.parentID = "msg_unrelated123";
    },
    (value: typeof reply) => {
      value.info.sessionID = otherSession;
    },
    (value: typeof reply) => {
      value.info.finish = "tool-calls";
    },
    (value: typeof reply) => {
      value.info.finish = "unknown";
    },
    (value: typeof reply) => {
      value.info.finish = "";
    },
  ]) {
    const value = structuredClone(reply);
    mutate(value);
    f.api.client.session.messages.mockResolvedValue({ data: [value] });
    expect(await f.runtime.settlement({ messageId })).toEqual({ state: "pending" });
  }
  f.api.client.session.messages.mockResolvedValue({ data: [reply] });
  expect(await f.runtime.settlement({ messageId })).toMatchObject({
    state: "completed",
    ok: true,
    text: "Done",
  });
  expect(f.api.client.session.messages).toHaveBeenLastCalledWith(
    { sessionID: sessionId, limit: 100 },
    expect.anything(),
  );
});

test("native status lookup failure and concurrent sends cannot become an idle successful dispatch", async () => {
  const f = fixture();
  await f.initialize();
  f.api.client.session.status.mockRejectedValueOnce(new Error("native unavailable"));
  expect((await f.send()).outcome).toBe("unavailable");
  let release!: () => void;
  f.controller.claim.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.send();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect((await f.send()).outcome).toBe("unavailable");
  release();
  expect((await first).outcome).toBe("accepted");
  expect(f.api.client.session.promptAsync).toHaveBeenCalledOnce();
});

test.each([
  [],
  null,
  { [sessionId]: {} },
  { [sessionId]: { type: null } },
  { [sessionId]: { type: "future" } },
  { [sessionId]: { type: "retry" } },
])("malformed native status %j never becomes idle or submits", async (data) => {
  const f = fixture();
  await f.initialize();
  f.api.client.session.status.mockResolvedValue({ data } as never);
  expect((await f.send()).outcome).toBe("unavailable");
  expect(f.controller.claim).not.toHaveBeenCalled();
  expect(f.api.client.session.promptAsync).not.toHaveBeenCalled();
});

test.each([{}, { type: null }, { type: "future" }, { type: "retry" }])(
  "malformed local status %j after claim prevents submission",
  async (status) => {
    const f = fixture();
    await f.initialize();
    f.api.state.session.status = () => status as never;
    expect((await f.send()).outcome).toBe("unavailable");
    expect(f.api.client.session.promptAsync).not.toHaveBeenCalled();
    expect(f.controller.receipt).toHaveBeenCalledWith({ sessionId, messageId, outcome: "not-sent" });
  },
);

test("native absent idle entry is accepted; valid retry is working", async () => {
  const f = fixture();
  await f.initialize();
  f.api.client.session.status.mockResolvedValue({ data: {} });
  expect((await f.send()).outcome).toBe("accepted");
  f.api.client.session.status.mockResolvedValue({
    data: { [sessionId]: { type: "retry", attempt: 1, message: "waiting", next: 1234 } },
  } as never);
  expect(await f.runtime.status()).toBe("working");
});
