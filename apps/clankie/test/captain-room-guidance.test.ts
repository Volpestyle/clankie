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

const fake = vi.hoisted(() => ({
  session: undefined as unknown,
  sessionFactory: undefined as undefined | (() => unknown),
}));
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
  createAgentSession: async () => ({ session: fake.sessionFactory?.() ?? fake.session }),
  DefaultResourceLoader: class {
    async reload() {}
    getSkills() {
      return { skills: [] };
    }
  },
}));
vi.mock("../src/captain/lane-tools.ts", () => ({ laneAuthoredTools: () => [], buildLaneToolBank: () => [] }));

it("parallel room children consume guidance once and keep separate tool captures", async () => {
  const root = mkdtempSync(join(tmpdir(), "captain-room-guidance-"));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  let releaseGuard!: () => void;
  let guardEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    guardEntered = resolve;
  });
  const finishes: (() => void)[] = [];
  const calls: { text: string; behavior: string | undefined }[] = [];
  fake.sessionFactory = () => {
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
          finishes.push(() => {
            for (const listener of listeners)
              listener({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "Clankie's answer" }] },
              });
            session.isStreaming = false;
            resolve();
          });
        });
      },
    };
    return session;
  };
  const observations = new DiscordRoomObservations(join(root, "health.json"));
  const room = `room-${createHash("sha256").update("discord_presence:12345:67890").digest("hex").slice(0, 24)}`;
  const guard = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  observations.setGuidance(room, "PRIVATE_OWNER_CONTEXT", 0, () => {
    guardEntered();
    return guard;
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
  // Different speakers: one sender's follow-up would steer their running child instead.
  const request = (id: string, actorId = "11111"): DiscordPresenceChannelTurnRequest => ({
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
      actorId,
      body: id,
      attachments: [],
    },
    contextMessages: [],
  });
  try {
    const first = captain.submitDiscordTurn(request("first"));
    await entered;
    const second = captain.submitDiscordTurn(request("second", "22222"));
    // Both independent children reach their heard log while guidance authorization is pending.
    await heard;
    releaseGuard();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.filter((call) => call.text.includes("PRIVATE_OWNER_CONTEXT"))).toHaveLength(1);
    expect(calls.every((call) => call.behavior === undefined)).toBe(true);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({ discord: expect.objectContaining({ messageId: "first" }) }),
    );
    for (const finish of finishes) finish();
    expect(await first).toMatchObject({ state: "settled" });
    expect(await second).toMatchObject({ state: "settled" });
    expect(observations.status(room).guidance.state).toBe("consumed");
  } finally {
    for (const finish of finishes) finish();
    fake.sessionFactory = undefined;
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
