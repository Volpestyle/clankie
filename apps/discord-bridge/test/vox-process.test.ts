import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { VOX_IPC_PROTOCOL_VERSION } from "@clankie/vox-client";
import { describe, expect, it } from "vitest";
import { shutdownDiscordBridge } from "../src/shutdown.ts";
import { probeVoxProcess, startOfficialBotVox, waitForVoxProcessReady } from "../src/vox-process.ts";
import { FakeVox } from "./fake-vox.ts";

describe("official bot Vox process ownership", () => {
  it("creates exactly one app-lifetime child and waits for process_ready", async () => {
    const vox = new FakeVox();
    vox.status = "starting";
    let createCalls = 0;
    const started = startOfficialBotVox({
      enabled: true,
      createClient: () => {
        createCalls += 1;
        return vox;
      },
      timeoutMs: 1_000,
    });
    let settled = false;
    void started.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    vox.emitProcessReady();

    await expect(started).resolves.toBe(vox);
    expect(createCalls).toBe(1);
    expect(vox.closeCalls).toBe(0);
  });

  it("fails clearly instead of falling back when Vox is unavailable", async () => {
    const vox = new FakeVox();
    vox.status = "missing";
    vox.detail = "owned binary missing";

    await expect(
      startOfficialBotVox({ enabled: true, createClient: () => vox, timeoutMs: 10 }),
    ).rejects.toThrow("Discord voice requires the Vox media process: owned binary missing");
    expect(vox.closeCalls).toBe(1);
  });

  it("reports binary resolution separately from the bounded process smoke", async () => {
    const vox = new FakeVox();
    vox.status = "starting";
    const probing = probeVoxProcess({
      env: { CLANKIE_VOX_BIN: process.execPath },
      createClient: () => vox,
      timeoutMs: 1_000,
    });
    queueMicrotask(() => vox.emitProcessReady());

    await expect(probing).resolves.toEqual({
      binaryResolved: true,
      binaryDetail: "owned Vox binary resolved",
      processReady: true,
      processDetail: `Vox emitted process_ready protocol ${String(VOX_IPC_PROTOCOL_VERSION)}`,
    });
    expect(vox.closeCalls).toBe(1);
  });

  it("bounds a process that never becomes ready", async () => {
    const vox = new FakeVox();
    vox.status = "starting";
    await expect(waitForVoxProcessReady(vox, 1)).rejects.toThrow("before the timeout");
  });

  it("rejects a process_ready from any other Vox IPC protocol", async () => {
    const vox = new FakeVox();
    vox.status = "starting";
    const waiting = waitForVoxProcessReady(vox, 1_000);
    vox.emitProcessReady(VOX_IPC_PROTOCOL_VERSION + 1);

    await expect(waiting).rejects.toThrow(
      `Vox IPC protocol mismatch: client=${String(VOX_IPC_PROTOCOL_VERSION)} binary=${String(VOX_IPC_PROTOCOL_VERSION + 1)}`,
    );
  });

  it("shuts down ingress, voice, Vox, and Discord in ownership order", async () => {
    const order: string[] = [];
    await shutdownDiscordBridge({
      stopIngress: () => {
        order.push("ingress");
      },
      leaveVoice: () => {
        order.push("leave");
        return Promise.resolve();
      },
      disposeVoiceSession: () => {
        order.push("session.dispose");
        return Promise.resolve();
      },
      disposeVoiceGateway: () => {
        order.push("gateway.dispose");
      },
      closeVox: () => {
        order.push("vox.close");
      },
      destroyDiscord: () => {
        order.push("discord.destroy");
      },
      stopPresence: () => {
        order.push("presence.stop");
        return Promise.resolve();
      },
      recordStopped: () => {
        order.push("receipt");
        return Promise.resolve();
      },
    });
    expect(order).toEqual([
      "ingress",
      "leave",
      "session.dispose",
      "gateway.dispose",
      "vox.close",
      "discord.destroy",
      "presence.stop",
      "receipt",
    ]);
  });

  it("publishes presence-off and records stopped after leave failure, then reports the first error", async () => {
    const order: string[] = [];
    await expect(
      shutdownDiscordBridge({
        stopIngress: () => {
          order.push("ingress");
        },
        leaveVoice: async () => {
          order.push("leave");
          throw new Error("leave failed");
        },
        disposeVoiceSession: async () => {
          order.push("session.dispose");
          throw new Error("dispose failed");
        },
        disposeVoiceGateway: () => order.push("gateway.dispose"),
        closeVox: () => order.push("vox.close"),
        destroyDiscord: () => order.push("discord.destroy"),
        stopPresence: async () => void order.push("presence.stop"),
        recordStopped: async () => void order.push("receipt"),
      }),
    ).rejects.toThrow("leave failed");
    expect(order).toEqual([
      "ingress",
      "leave",
      "session.dispose",
      "gateway.dispose",
      "vox.close",
      "discord.destroy",
      "presence.stop",
      "receipt",
    ]);
  });

  it("has no legacy Node media owner dependency or construction", async () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const source = await Promise.all(
      ["index.ts", "voice-readiness.ts"].map((name) => readFile(resolve(packageRoot, "src", name), "utf8")),
    );

    expect(manifest.dependencies["@clankie/vox-client"]).toBe("workspace:*");
    expect(manifest.dependencies).not.toHaveProperty("@discordjs/voice");
    expect(manifest.dependencies).not.toHaveProperty("@discordjs/opus");
    expect(manifest.dependencies).not.toHaveProperty("prism-media");
    expect(source.join("\n")).not.toMatch(/@discordjs\/voice|prism-media|createAudioPlayer/u);
  });
});
