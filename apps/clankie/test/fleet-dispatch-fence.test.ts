import { expect, it, vi } from "vitest";
import { fixture } from "./fleet-host-fence.fixture.ts";

function barrier() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  return {
    get held() {
      return held;
    },
    hold: async () => {
      held = true;
      await pending;
    },
    wait: () => vi.waitFor(() => expect(held).toBe(true)),
    release: () => release(),
  };
}
const invocation = { name: "linear_read_0", arguments: { id: "A-1" } };

it.each(["local", "stream", "bearer"] as const)(
  "fences %s disconnection after admission during the final settings read",
  async (admission) => {
    const f = await fixture(admission);
    const held = barrier();
    let afterAdmission = false;
    const originalCall = f.host.call.bind(f.host);
    f.host.call = async (input) =>
      originalCall({
        ...input,
        fence: async () => {
          const guard = await input.fence!();
          afterAdmission = true;
          return guard;
        },
      });
    const load = f.settings.load.bind(f.settings);
    try {
      expect((await f.call("clankie_call", invocation)).isError).toBe(false);
      afterAdmission = false;
      vi.spyOn(f.settings, "load").mockImplementation(async () => {
        const value = await load();
        if (afterAdmission && !held.held) await held.hold();
        return value;
      });
      const pending = f.call("clankie_call", invocation);
      await held.wait();
      if (admission === "local") f.socket.destroy();
      else f.state.live = false;
      held.release();
      expect((await pending).isError).toBe(true);
      expect(f.calls).toHaveBeenCalledOnce();
    } finally {
      held.release();
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it.each(["off", "server-disabled", "account"] as const)(
  "retains %s authority changes while final async admission is held",
  async (change) => {
    const f = await fixture("stream");
    const held = barrier();
    let inHost = false;
    const originalCall = f.host.call.bind(f.host);
    f.host.call = async (input) => {
      inHost = true;
      return originalCall(input);
    };
    try {
      expect((await f.call("clankie_call", invocation)).isError).toBe(false);
      inHost = false;
      f.state.onValidate = async () => {
        if (inHost && !held.held) await held.hold();
      };
      const pending = f.call("clankie_call", invocation);
      await held.wait();
      if (change === "off") await f.setTools("off");
      else if (change === "server-disabled") await f.disableServers();
      else
        await f.credentials.set("linear", {
          type: "api",
          key: "replacement",
          account: { ...f.account, userId: "replacement" },
        });
      held.release();
      expect((await pending).isError).toBe(true);
      expect(f.calls).toHaveBeenCalledOnce();
    } finally {
      held.release();
      await f.close();
    }
  },
);

it.each(["off", "disconnect", "server-disabled"] as const)(
  "prevents wire dispatch when %s occurs during real HTTP transport credential I/O",
  async (change) => {
    const f = await fixture("stream", true);
    const held = barrier();
    let dispatched = false;
    const current = f.identity.current;
    const get = f.credentials.get.bind(f.credentials);
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      expect((await f.call("clankie_call", invocation)).isError).toBe(false);
      f.identity.current = () => {
        dispatched = true;
        return current();
      };
      spy = vi.spyOn(f.credentials, "get").mockImplementation(async (id) => {
        const value = await get(id);
        if (id === "linear" && dispatched && !held.held) await held.hold();
        return value;
      });
      const pending = f.call("clankie_call", invocation);
      await held.wait();
      if (change === "off") await f.setTools("off");
      else if (change === "server-disabled") await f.disableServers();
      else f.state.live = false;
      held.release();
      expect((await pending).isError).toBe(true);
      expect(f.calls).toHaveBeenCalledOnce();
    } finally {
      held.release();
      spy?.mockRestore();
      await f.close();
    }
  },
);

it("keeps overlapping HTTP dispatch guards separate on one connection", async () => {
  const f = await fixture("stream", true);
  const held = barrier();
  const get = f.credentials.get.bind(f.credentials);
  let dispatchedA = false;
  let liveA = true;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect((await f.call("clankie_call", invocation)).isError).toBe(false);
    spy = vi.spyOn(f.credentials, "get").mockImplementation(async (id) => {
      const value = await get(id);
      if (id === "linear" && dispatchedA && !held.held) await held.hold();
      return value;
    });
    const input = { lane: "operator" as const, server: "linear", tool: "read_0", arguments: {} };
    const pendingA = f.host.call({
      ...input,
      fence: async () => () => {
        dispatchedA = true;
        if (!liveA) throw new Error("A disconnected");
      },
    });
    await held.wait();
    liveA = false;
    expect(await f.host.call(input)).toMatchObject({ outcome: "ok" });
    expect((await f.call("clankie_call", invocation)).isError).toBe(false);
    held.release();
    expect(await pendingA).toMatchObject({ outcome: "refused" });
    expect(f.calls).toHaveBeenCalledTimes(3); // Control, operator, fleet; A never reached mocked fetch.
    expect(await f.host.call(input)).toMatchObject({ outcome: "ok" });
    expect(f.calls).toHaveBeenCalledTimes(4); // Cleanup/refusal did not contaminate the next connection.
  } finally {
    held.release();
    spy?.mockRestore();
    await f.close();
  }
});

it.each(["missing", "throwing"] as const)("fails closed on a %s final link-current guard", async (kind) => {
  const f = await fixture("stream");
  try {
    expect((await f.call("clankie_call", invocation)).isError).toBe(false);
    if (kind === "missing") Reflect.deleteProperty(f.identity, "current");
    else
      f.identity.current = () => {
        throw new Error("unavailable");
      };
    expect((await f.call("clankie_call", invocation)).isError).toBe(true);
    expect(f.calls).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("fences local listener close after full proof while host account I/O is held", async () => {
  const f = await fixture("local");
  const held = barrier();
  let afterAdmission = false;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect((await f.call("clankie_call", invocation)).isError).toBe(false);
    const originalCall = f.host.call.bind(f.host);
    f.host.call = (input) =>
      originalCall({
        ...input,
        fence: async () => {
          const current = await input.fence!();
          afterAdmission = true;
          return current;
        },
      });
    const get = f.credentials.get.bind(f.credentials);
    spy = vi.spyOn(f.credentials, "get").mockImplementation(async (id) => {
      const value = await get(id);
      if (id === "linear" && afterAdmission && !held.held) await held.hold();
      return value;
    });
    const pending = f.call("clankie_call", invocation);
    await held.wait();
    await f.local.close();
    held.release();
    expect((await pending).isError).toBe(true);
    expect(f.calls).toHaveBeenCalledOnce();
  } finally {
    held.release();
    spy?.mockRestore();
    await f.close();
  }
});

it("does not retire a healthy connection when another call is refused before wire dispatch", async () => {
  const f = await fixture("stream", true);
  const permitted = barrier();
  const refused = barrier();
  let nextWire: "permitted" | "refused" | undefined;
  let live = true;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect((await f.call("clankie_call", invocation)).isError).toBe(false);
    const get = f.credentials.get.bind(f.credentials);
    spy = vi.spyOn(f.credentials, "get").mockImplementation(async (id) => {
      const wire = nextWire;
      nextWire = undefined;
      const value = await get(id);
      if (id === "linear" && wire === "permitted") await permitted.hold();
      if (id === "linear" && wire === "refused") await refused.hold();
      return value;
    });
    const fence = (role: "permitted" | "refused") => {
      let first = true;
      return async () => () => {
        if (first) {
          first = false;
          nextWire = role;
        }
        if (role === "refused" && !live) throw new Error("Fleet disconnected");
      };
    };
    const input = { lane: "operator" as const, server: "linear", tool: "read_0", arguments: {} };
    const pendingPermitted = f.host.call({ ...input, fence: fence("permitted") });
    await permitted.wait();
    const pendingRefused = f.host.call({ ...input, fence: fence("refused") });
    await refused.wait();
    live = false;
    refused.release();
    expect(await pendingRefused).toMatchObject({ outcome: "refused" });
    permitted.release();
    expect(await pendingPermitted).toMatchObject({ outcome: "ok" });
    expect(f.calls).toHaveBeenCalledTimes(2);
  } finally {
    permitted.release();
    refused.release();
    spy?.mockRestore();
    await f.close();
  }
});

it("fails closed when a fleet has no canonical settings snapshot supplier", async () => {
  const f = await fixture("stream", false, false);
  try {
    expect((await f.call("clankie_call", invocation)).isError).toBe(true);
    expect(f.calls).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("fails closed when the canonical settings snapshot read throws", async () => {
  const f = await fixture("stream");
  try {
    expect((await f.call("clankie_call", invocation)).isError).toBe(false);
    f.state.onToolsRead = async () => {
      throw new Error("settings unavailable");
    };
    expect((await f.call("clankie_call", invocation)).isError).toBe(true);
    expect(f.calls).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
