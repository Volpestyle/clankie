import { expect, it, vi } from "vitest";
import { fixture } from "./fleet-host-fence.fixture.ts";

// Public HTTP MCP -> real WorkerMcp -> real createMcpHost. Only provider clients are doubles.
// No native stores, real credentials, external requests, settings or services are touched.
it.each(["off", "disconnect"] as const)(
  "refuses %s during the real host credential await",
  async (change) => {
    const f = await fixture("stream");
    let release = () => {};
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let credentialSpy: ReturnType<typeof vi.spyOn> | undefined;
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
      let hostEntered = false;
      let validationsAtHostEntry = 0;
      let held = false;
      f.state.onValidate = async () => {
        validations++;
      };
      const originalCall = f.host.call.bind(f.host);
      f.host.call = async (input) => {
        hostEntered = true;
        validationsAtHostEntry = validations;
        return originalCall(input);
      };
      const originalGet = f.credentials.get.bind(f.credentials);
      credentialSpy = vi.spyOn(f.credentials, "get").mockImplementation(async (id) => {
        const value = await originalGet(id);
        if (id === "linear" && hostEntered && !held) {
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
          timeout = setTimeout(() => reject(new Error("host credential barrier not reached")), 5000);
        }),
      ]);
      expect(validationsAtHostEntry).toBe(3);
      if (change === "off") f.state.tools = "off";
      else f.state.live = false;
      release();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(f.calls).toHaveBeenCalledOnce();
    } finally {
      release();
      if (timeout) clearTimeout(timeout);
      credentialSpy?.mockRestore();
      await f.close();
    }
  },
);

// The fence awaits fleet admission; the switch and server config must still be read after it.
it.each(["off", "server-disabled"] as const)(
  "refuses %s during the new final host fence await",
  async (change) => {
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
      let hostEntered = false;
      let held = false;
      const originalCall = f.host.call.bind(f.host);
      f.host.call = async (input) => {
        hostEntered = true;
        return originalCall(input);
      };
      f.state.onValidate = async () => {
        if (hostEntered && !held) {
          held = true;
          entered();
          await barrier;
        }
      };
      const pending = f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } });
      await Promise.race([
        waiting,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("new final host admission await not reached")), 5000);
        }),
      ]);
      if (change === "off") f.state.tools = "off";
      else f.state.serversEnabled = false;
      release();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(f.calls).toHaveBeenCalledOnce();
    } finally {
      release();
      if (timeout) clearTimeout(timeout);
      await f.close();
    }
  },
);
