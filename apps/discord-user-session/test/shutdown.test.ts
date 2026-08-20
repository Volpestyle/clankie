import { describe, expect, it } from "vitest";
import { createUserSessionShutdown } from "../src/shutdown.ts";

describe("user-session shutdown", () => {
  it("disconnects roles and listeners before closing the shared Vox child once", async () => {
    const order: string[] = [];
    const shutdown = createUserSessionShutdown({
      quiesceCallbacks: () => order.push("callbacks"),
      stopControls: () => order.push("controls"),
      stopStreams: () => order.push("streams"),
      disposeGatewayBridge: () => order.push("bridge_dispose"),
      leaveVoice: async () => void order.push("voice_leave"),
      releaseVoiceMembership: () => order.push("voice_membership"),
      disposeVoice: async () => void order.push("voice_dispose"),
      closeVox: () => order.push("vox_close"),
      closeGateway: () => order.push("gateway_close"),
      stopPresence: async () => void order.push("presence_close"),
      recordStopped: async () => void order.push("receipt"),
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(order).toEqual([
      "callbacks",
      "controls",
      "streams",
      "bridge_dispose",
      "voice_leave",
      "voice_membership",
      "voice_dispose",
      "vox_close",
      "gateway_close",
      "presence_close",
      "receipt",
    ]);
    expect(order.filter((step) => step === "vox_close")).toHaveLength(1);
  });

  it("still closes Vox and the gateway when voice leave fails", async () => {
    const order: string[] = [];
    const shutdown = createUserSessionShutdown({
      quiesceCallbacks: () => undefined,
      stopControls: () => undefined,
      stopStreams: () => undefined,
      disposeGatewayBridge: () => undefined,
      leaveVoice: async () => {
        throw new Error("leave failed");
      },
      releaseVoiceMembership: () => undefined,
      disposeVoice: async () => undefined,
      closeVox: () => order.push("vox_close"),
      closeGateway: () => order.push("gateway_close"),
      stopPresence: async () => undefined,
      recordStopped: async () => undefined,
    });

    await expect(shutdown("SIGTERM")).rejects.toThrow("leave failed");
    expect(order).toEqual(["vox_close", "gateway_close"]);
  });

  it("quiesces an interleaved dispatch before any media release", async () => {
    const order: string[] = [];
    let closed = false;
    const dispatch = (): void => {
      if (!closed) order.push("dispatch_started_stream");
    };
    const shutdown = createUserSessionShutdown({
      quiesceCallbacks: () => {
        closed = true;
        order.push("callbacks");
        dispatch();
      },
      stopControls: () => undefined,
      stopStreams: () => order.push("streams"),
      disposeGatewayBridge: () => order.push("bridge"),
      leaveVoice: async () => undefined,
      releaseVoiceMembership: () => order.push("membership"),
      disposeVoice: async () => undefined,
      closeVox: () => order.push("vox"),
      closeGateway: () => undefined,
      stopPresence: async () => undefined,
      recordStopped: async () => undefined,
    });

    await shutdown("SIGTERM");
    expect(order).toEqual(["callbacks", "streams", "bridge", "membership", "vox"]);
  });
});
