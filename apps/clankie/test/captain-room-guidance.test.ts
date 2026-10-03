import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";

const fake = vi.hoisted(() => ({ session: undefined as unknown }));
vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => ({
    runtime: {},
    resolveRoute: async () => ({
      selection: { model: { id: "fake", provider: "fake", contextWindow: 1000 }, thinkingLevel: "off" },
    }),
  }),
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession: async () => ({ session: fake.session }),
  DefaultResourceLoader: class {
    async reload() {}
    getSkills() {
      return { skills: [] };
    }
  },
}));
vi.mock("../src/captain/lane-tools.ts", () => ({ laneAuthoredTools: () => [], buildLaneToolBank: () => [] }));

it("the reserved natural room turn retains guidance when a concurrent delivery changes the tool capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "captain-room-guidance-"));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  let releaseGuard!: () => void;
  let guardEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    guardEntered = resolve;
  });
  let finish!: () => void;
  const calls: { text: string; behavior: string | undefined }[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const session = {
    isStreaming: false,
    state: { messages: [] },
    model: { id: "fake", provider: "fake", contextWindow: 1000 },
    thinkingLevel: "off",
    bindExtensions: async () => {},
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getContextUsage: () => undefined,
    abort: async () => {},
    dispose: () => {},
    prompt: (text: string, options?: { streamingBehavior?: string }) => {
      calls.push({ text, behavior: options?.streamingBehavior });
      if (options?.streamingBehavior === "steer") return Promise.resolve();
      session.isStreaming = true;
      return new Promise<void>((resolve) => {
        finish = () => {
          for (const listener of listeners)
            listener({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "Clankie's answer" }] },
            });
          session.isStreaming = false;
          resolve();
        };
      });
    },
  };
  fake.session = session;
  const observations = new DiscordRoomObservations(join(root, "health.json"));
  const room = `room-${createHash("sha256").update("discord_presence:12345:67890").digest("hex").slice(0, 24)}`;
  observations.setGuidance(room, "PRIVATE_OWNER_CONTEXT", 0, () => {
    guardEntered();
    return new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
  });
  let secondHeard!: () => void;
  const heard = new Promise<void>((resolve) => {
    secondHeard = resolve;
  });
  const append = LaneLog.prototype.append;
  vi.spyOn(LaneLog.prototype, "append").mockImplementation(async function (this: LaneLog, ...args) {
    await append.apply(this, args);
    if (args[2].kind === "heard" && args[2].text.includes("second")) secondHeard();
  });
  const route = vi.fn(() => true);
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      memory: {},
      roomObservations: observations,
      conversationRouteAuthorized: route,
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      settings: new SettingsStore(join(root, "settings.json")),
      personaImages: async () => ({ images: [], hash: "fake", files: [] }),
    },
  );
  const request = (id: string): DiscordPresenceChannelTurnRequest => ({
    schemaVersion: 1,
    deliveryId: id,
    identity: {
      presenceSessionId: "body",
      correlationId: id,
      profileHash: "hash",
      characterId: "clankie",
      credentialRef: "fake",
      transportKind: "bot",
    },
    trigger: {
      kind: "message",
      id,
      guildId: "12345",
      channelId: "67890",
      actorId: "11111",
      body: id,
      attachments: [],
    },
    contextMessages: [],
  });
  try {
    const first = captain.submitDiscordTurn(request("first"));
    await entered;
    const second = captain.submitDiscordTurn(request("second"));
    // Reach runDiscordTurn's second heard append (and therefore its real capture mutation)
    // while the first turn's private authority check remains suspended.
    await heard;
    releaseGuard();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.text).toContain("PRIVATE_OWNER_CONTEXT");
    expect(calls[1]).toMatchObject({ behavior: "steer" });
    expect(calls[1]!.text).not.toContain("PRIVATE_OWNER_CONTEXT");
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({ discord: expect.objectContaining({ messageId: "first" }) }),
    );
    finish();
    expect(await first).toMatchObject({ state: "settled" });
    expect(await second).toMatchObject({ state: "absorbed", replyDeliveryId: "first" });
    expect(observations.status(room).guidance.state).toBe("consumed");
  } finally {
    finish?.();
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
