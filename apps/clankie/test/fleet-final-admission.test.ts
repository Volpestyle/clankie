import { expect, it, vi } from "vitest";
import { fixture } from "./fleet-host-fence.fixture.ts";

it.each(["off", "disconnect"] as const)(
  "refuses %s during the post-fence final host account check",
  async (change) => {
    const f = await fixture("stream");
    let release = () => {};
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const control = await f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } });
      expect(control.isError).toBe(false);
      expect(f.calls).toHaveBeenCalledOnce();
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let hostEntered = false;
      let finalAdmissionSeen = false;
      let held = false;
      let validations = 0;
      const originalCall = f.host.call.bind(f.host);
      f.host.call = async (input) => {
        hostEntered = true;
        return originalCall(input);
      };
      f.state.onValidate = async () => {
        validations++;
        if (hostEntered) finalAdmissionSeen = true;
      };
      const originalGet = f.credentials.get.bind(f.credentials);
      spy = vi.spyOn(f.credentials, "get").mockImplementation(async (id) => {
        const value = await originalGet(id);
        if (id === "linear" && hostEntered && finalAdmissionSeen && !held) {
          held = true;
          entered();
          await barrier;
        }
        return value;
      });
      const pending = f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } });
      await Promise.race([
        waiting,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("post-fence host account await not reached")), 5000);
        }),
      ]);
      if (change === "off") await f.setTools("off");
      else f.state.live = false;
      release();
      const result = await pending;
      console.log(
        JSON.stringify({
          diagnostic: "post-fence-host-account-await",
          change,
          validations,
          resultIsError: result.isError,
          upstreamCallsIncludingControl: f.calls.mock.calls.length,
          providers:
            "all mocked; real WorkerMcp/host; temporary fake store; production account/config unchanged",
        }),
      );
      expect(result.isError).toBe(true);
      expect(f.calls).toHaveBeenCalledOnce();
    } finally {
      release();
      if (timeout) clearTimeout(timeout);
      spy?.mockRestore();
      await f.close();
    }
  },
);

it("refuses dispatch when fleet.tools turns off during final async admission validation", async () => {
  const f = await fixture("stream");
  let release = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const control = await f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } });
    expect(control.isError).toBe(false);
    expect(f.calls).toHaveBeenCalledOnce();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let validations = 0;
    f.state.onValidate = async () => {
      if (++validations === 3) {
        entered();
        await barrier;
      }
    };
    const pending = f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } });
    await Promise.race([
      waiting,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("final admission barrier not reached")), 5000);
      }),
    ]);
    await f.setTools("off");
    release();
    const result = await pending;
    console.log(
      JSON.stringify({
        diagnostic: "final-admission-off",
        validations,
        toolsAtDispatch: (await f.settings.load()).fleet.tools,
        resultIsError: result.isError,
        upstreamCallsIncludingPermittedControl: f.calls.mock.calls.length,
        providers: "all mocked; no live request",
      }),
    );
    expect(result.isError).toBe(true);
    expect(f.calls).toHaveBeenCalledOnce();
  } finally {
    release();
    if (timeout) clearTimeout(timeout);
    await f.close();
  }
});

// Admission already returned true; the final settings read is still async.
it("refuses disconnect during the final fleet tools read", async () => {
  const f = await fixture("stream");
  let release = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const control = await f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } });
    expect(control.isError).toBe(false);
    expect(f.calls).toHaveBeenCalledOnce();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finalAdmissionSeen = false;
    let hostEntered = false;
    let held = false;
    const originalCall = f.host.call.bind(f.host);
    f.host.call = async (input) => {
      hostEntered = true;
      return originalCall(input);
    };
    f.state.onValidate = async () => {
      if (hostEntered) finalAdmissionSeen = true;
    };
    f.state.onToolsRead = async () => {
      if (finalAdmissionSeen && !held) {
        held = true;
        entered();
        await barrier;
      }
    };
    const pending = f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } });
    await Promise.race([
      waiting,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("final tools read not reached")), 5000);
      }),
    ]);
    f.state.live = false;
    release();
    const result = await pending;
    console.log(
      JSON.stringify({
        diagnostic: "final-tools-read-disconnect",
        resultIsError: result.isError,
        upstreamCallsIncludingControl: f.calls.mock.calls.length,
        providers: "all mocked; no live request",
      }),
    );
    expect(result.isError).toBe(true);
    expect(f.calls).toHaveBeenCalledOnce();
  } finally {
    release();
    if (timeout) clearTimeout(timeout);
    await f.close();
  }
});
