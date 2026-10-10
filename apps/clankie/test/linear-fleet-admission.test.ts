import { expect, it, vi } from "vitest";
import { fixture } from "./fleet-host-fence.fixture.ts";

function barrier() {
  let release!: () => void;
  let held = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
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

// Reads intentionally bypass optional attribution. Exercise a real offered write instead.
const invocation = { name: "linear_save_issue", arguments: { id: "A-1", title: "Updated fixture issue" } };

it.each(["off", "disconnect"] as const)(
  "keeps fleet %s admission after Linear author attribution awaits",
  async (change) => {
    const f = await fixture("stream", true, true, { linearWrite: true });
    const held = barrier();
    try {
      expect((await f.call("clankie_call", invocation)).isError).toBe(false);
      expect(f.calls).toHaveBeenNthCalledWith(1, "save_issue", invocation.arguments);
      const call = f.host.call.bind(f.host);
      f.host.call = (input) =>
        call({
          ...input,
          conversationAuthority: {
            owner: { conversationId: "original-lead" },
            current: () => true,
            authorize: async () => {
              await held.hold();
              return true;
            },
          },
        });
      const pending = f.call("clankie_call", invocation);
      await held.wait();
      if (change === "off") await f.setTools("off");
      else f.state.live = false;
      held.release();
      expect((await pending).isError).toBe(true);
      expect(f.calls).toHaveBeenCalledOnce();
    } finally {
      held.release();
      await f.close();
    }
  },
);

it("retains the final HTTP dispatch fence with an admitted Linear author", async () => {
  const f = await fixture("stream", true, true, { linearWrite: true });
  const held = barrier();
  let dispatchChecks = 0;
  const authorize = vi.fn(async () => true);
  try {
    expect((await f.call("clankie_call", invocation)).isError).toBe(false);
    expect(f.calls).toHaveBeenNthCalledWith(1, "save_issue", invocation.arguments);
    const call = f.host.call.bind(f.host);
    f.host.call = (input) =>
      call({
        ...input,
        conversationAuthority: {
          owner: { conversationId: "original-lead" },
          current: () => true,
          authorize,
        },
      });
    const current = f.identity.current;
    f.identity.current = () => {
      dispatchChecks++;
      return current();
    };
    const get = f.credentials.get.bind(f.credentials);
    vi.spyOn(f.credentials, "get").mockImplementation(async (id) => {
      const credential = await get(id);
      // Two logical dispatch checks precede the SDK's HTTP credential/header await.
      // Hold the actual wire selection, after write attribution and both checks.
      if (id === "linear" && dispatchChecks === 2 && !held.held) await held.hold();
      return credential;
    });
    const pending = f.call("clankie_call", invocation);
    await held.wait();
    expect(authorize).toHaveBeenCalledOnce();
    expect(dispatchChecks).toBe(2);
    f.state.live = false;
    held.release();
    expect((await pending).isError).toBe(true);
    expect(f.calls).toHaveBeenCalledOnce();
  } finally {
    held.release();
    vi.restoreAllMocks();
    await f.close();
  }
});
