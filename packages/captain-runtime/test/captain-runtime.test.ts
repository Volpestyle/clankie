import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CaptainAdmissionController,
  CaptainAdmissionQueueFullError,
  CaptainAdmissionPreemptedError,
  CaptainContinuationOwnershipError,
  CaptainLaneExecutor,
  CaptainLaneSessionConflictError,
  CaptainProviderPressureError,
  createAdmittedLanguageModel,
  openCaptainLaneRegistry,
  type CaptainIdentity,
  type CaptainLaneAddress,
  type CaptainRuntimeEvent,
} from "../src/index.ts";

const roots: string[] = [];
const identity: CaptainIdentity = {
  agentDefinitionId: "captain-eve:v1",
  soulId: "clankie",
  providerId: "openai-codex",
  characterId: "clankie",
};
const TUI: CaptainLaneAddress = { characterId: "clankie", lane: "tui", targetId: "operator" };
const VOICE: CaptainLaneAddress = {
  characterId: "clankie",
  lane: "discord_voice",
  targetId: "guild-1:voice-1",
};
const GAMEPLAY: CaptainLaneAddress = {
  characterId: "clankie",
  lane: "gameplay",
  targetId: "world-1",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registryHarness(events: CaptainRuntimeEvent[] = []) {
  const root = await mkdtemp(join(tmpdir(), "captain-lanes-"));
  roots.push(root);
  const path = join(root, "private", "lanes.sqlite");
  const registry = await openCaptainLaneRegistry(path, {
    identity,
    clock: () => new Date("2026-07-11T12:00:00.000Z"),
    events: (event) => {
      events.push(event);
    },
  });
  return { events, path, registry };
}

describe("durable captain lane registry", () => {
  it("restores one lane per target without exposing or duplicating continuation ownership", async () => {
    const test = await registryHarness();
    await test.registry.register(TUI);
    await test.registry.bindSession(TUI, { sessionId: "session-tui", continuationToken: "token-tui" });
    await test.registry.register(VOICE);
    await test.registry.bindSession(VOICE, {
      sessionId: "session-voice",
      continuationToken: "token-voice",
    });
    await test.registry.register(GAMEPLAY);
    await test.registry.bindSession(GAMEPLAY, {
      sessionId: "session-gameplay",
      continuationToken: "token-gameplay",
    });
    expect(test.registry.list()).toHaveLength(3);
    expect(JSON.stringify(test.registry.list())).not.toContain("token-");
    expect(JSON.stringify(test.events)).not.toContain("token-");
    expect(test.registry.identity).toEqual(identity);
    test.registry.close();

    const reopened = await openCaptainLaneRegistry(test.path, {
      identity,
      events: (event) => {
        test.events.push(event);
      },
    });
    await reopened.register(VOICE);
    await reopened.register(GAMEPLAY);
    expect(reopened.list()).toHaveLength(3);
    expect(reopened.resumeState(TUI)?.continuationToken).toBe("token-tui");
    expect(reopened.resumeState(VOICE)?.continuationToken).toBe("token-voice");
    expect(reopened.resumeState(GAMEPLAY)?.continuationToken).toBe("token-gameplay");
    expect(test.events.filter((event) => event.type === "lane.restored")).toHaveLength(2);
    reopened.close();
  });

  it("fails closed on cross-lane tokens, sessions, identities, and live replacement", async () => {
    const test = await registryHarness();
    await test.registry.bindSession(TUI, { sessionId: "session-tui", continuationToken: "token-tui" });
    await expect(
      test.registry.bindSession(VOICE, {
        sessionId: "session-voice",
        continuationToken: "token-tui",
      }),
    ).rejects.toBeInstanceOf(CaptainContinuationOwnershipError);
    await expect(
      test.registry.bindSession(VOICE, {
        sessionId: "session-tui",
        continuationToken: "token-voice",
      }),
    ).rejects.toBeInstanceOf(CaptainLaneSessionConflictError);
    await expect(
      test.registry.bindSession(TUI, {
        sessionId: "replacement",
        continuationToken: "replacement-token",
      }),
    ).rejects.toBeInstanceOf(CaptainLaneSessionConflictError);
    await test.registry.markSessionState(TUI, "session-tui", "completed");
    await expect(
      test.registry.bindSession(TUI, {
        sessionId: "replacement",
        continuationToken: "replacement-token",
      }),
    ).resolves.toMatchObject({ sessionId: "replacement", state: "active" });
    test.registry.close();

    await expect(
      openCaptainLaneRegistry(test.path, {
        identity: { ...identity, providerId: "anthropic" },
      }),
    ).rejects.toThrow(/identity does not match/);
  });
});

describe("foreground-aware provider admission", () => {
  it("runs TUI and voice independently when provider capacity exists", async () => {
    const controller = new CaptainAdmissionController({ capacity: 2 });
    const [tui, voice] = await Promise.all([
      controller.acquire({ requestId: "tui-1", laneKey: "tui", lane: "tui" }),
      controller.acquire({ requestId: "voice-1", laneKey: "voice", lane: "discord_voice" }),
    ]);
    expect(controller.snapshot().active).toEqual(["tui-1", "voice-1"]);
    tui.release();
    voice.release();
  });

  it("serializes each lane deterministically while prioritizing TUI then voice", async () => {
    const controller = new CaptainAdmissionController({ capacity: 1 });
    const blocker = await controller.acquire({
      requestId: "voice-blocker",
      laneKey: "voice-blocker",
      lane: "discord_voice",
    });
    const order: string[] = [];
    const gameplay = controller
      .acquire({ requestId: "gameplay", laneKey: "gameplay", lane: "gameplay" })
      .then((lease) => {
        order.push("gameplay");
        lease.release();
      });
    const voice = controller
      .acquire({ requestId: "voice", laneKey: "voice", lane: "discord_voice" })
      .then((lease) => {
        order.push("voice");
        lease.release();
      });
    const tuiFirst = controller.acquire({ requestId: "tui-1", laneKey: "tui", lane: "tui" }).then((lease) => {
      order.push("tui-1");
      lease.release();
    });
    const tuiSecond = controller
      .acquire({ requestId: "tui-2", laneKey: "tui", lane: "tui" })
      .then((lease) => {
        order.push("tui-2");
        lease.release();
      });
    blocker.release();
    await Promise.all([gameplay, voice, tuiFirst, tuiSecond]);
    expect(order).toEqual(["tui-1", "tui-2", "voice", "gameplay"]);
  });

  it("cancels borrowed gameplay so TUI admits next under a one-call limit", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/provider-pressure.json", import.meta.url), "utf8"),
    ) as { capacity: number; timeline: string[] };
    const events: CaptainRuntimeEvent[] = [];
    const timeline: string[] = [];
    const controller = new CaptainAdmissionController({
      capacity: fixture.capacity,
      events: (event) => {
        events.push(event);
      },
    });
    let gameplayStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      gameplayStarted = resolve;
    });
    const gameplay = controller
      .execute(
        { requestId: "gameplay-1", laneKey: "gameplay", lane: "gameplay" },
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            timeline.push("gameplay:start");
            gameplayStarted?.();
            signal.addEventListener(
              "abort",
              () => {
                timeline.push("gameplay:cancelled");
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      )
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(CaptainAdmissionPreemptedError);
      });
    await started;
    const tui = controller.execute({ requestId: "tui-1", laneKey: "tui", lane: "tui" }, () => {
      timeline.push("tui:start");
      timeline.push("tui:complete");
      return Promise.resolve();
    });
    await Promise.all([gameplay, tui]);
    const preemptIndex = events.findIndex((event) => event.type === "admission.preempt_requested");
    timeline.splice(1, 0, preemptIndex >= 0 ? "gameplay:preempt_requested" : "missing-preemption");
    expect(timeline).toEqual(fixture.timeline);
    expect(controller.snapshot()).toEqual({ active: [], queued: [] });
  });

  it("records provider-pressure parking without leaking or retrying globally", async () => {
    const events: CaptainRuntimeEvent[] = [];
    const controller = new CaptainAdmissionController({
      capacity: 1,
      events: (event) => {
        events.push(event);
      },
    });
    await expect(
      controller.execute({ requestId: "rate-limited", laneKey: "voice", lane: "discord_voice" }, () =>
        Promise.reject(new CaptainProviderPressureError("retry after 30 seconds")),
      ),
    ).rejects.toThrow("retry after 30 seconds");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "admission.parked", requestId: "rate-limited" }),
    );
    expect(controller.snapshot()).toEqual({ active: [], queued: [] });
  });

  it("bounds bursts per lane without blocking a different lane's queue", async () => {
    const controller = new CaptainAdmissionController({ capacity: 1, maxQueuedPerLane: 1 });
    const active = await controller.acquire({ requestId: "active", laneKey: "tui", lane: "tui" });
    const queuedTui = controller.acquire({ requestId: "tui-queued", laneKey: "tui", lane: "tui" });
    await expect(
      controller.acquire({ requestId: "tui-overflow", laneKey: "tui", lane: "tui" }),
    ).rejects.toBeInstanceOf(CaptainAdmissionQueueFullError);
    const queuedVoice = controller.acquire({
      requestId: "voice-queued",
      laneKey: "voice",
      lane: "discord_voice",
    });
    expect(controller.snapshot().queued).toEqual(["tui-queued", "voice-queued"]);
    active.release();
    const tui = await queuedTui;
    tui.release();
    const voice = await queuedVoice;
    voice.release();
  });
});

describe("lane-scoped execution and model calls", () => {
  it("routes responses to their origin and never supplies another lane's continuation", async () => {
    const test = await registryHarness();
    await test.registry.bindSession(TUI, { sessionId: "tui-session", continuationToken: "tui-token" });
    await test.registry.bindSession(VOICE, {
      sessionId: "voice-session",
      continuationToken: "voice-token",
    });
    const executor = new CaptainLaneExecutor(test.registry, new CaptainAdmissionController({ capacity: 2 }));
    const seen: string[] = [];
    const routed: string[] = [];
    await Promise.all([
      executor.dispatch({
        address: TUI,
        requestId: "tui-turn",
        sessionId: "tui-session",
        continuationToken: "tui-token",
        execute: ({ continuationToken }) => {
          seen.push(`tui:${continuationToken}`);
          return Promise.resolve({
            output: "tui response",
            sessionId: "tui-session",
            continuationToken: "tui-token-next",
          });
        },
        route: ({ address, output }) => {
          routed.push(`${address.targetId}:${output}`);
        },
      }),
      executor.dispatch({
        address: VOICE,
        requestId: "voice-turn",
        sessionId: "voice-session",
        continuationToken: "voice-token",
        execute: ({ continuationToken }) => {
          seen.push(`voice:${continuationToken}`);
          return Promise.resolve({
            output: "voice response",
            sessionId: "voice-session",
            continuationToken: "voice-token-next",
          });
        },
        route: ({ address, output }) => {
          routed.push(`${address.targetId}:${output}`);
        },
      }),
    ]);
    expect(seen.sort()).toEqual(["tui:tui-token", "voice:voice-token"]);
    expect(routed.sort()).toEqual(["guild-1:voice-1:voice response", "operator:tui response"]);
    expect(test.registry.resumeState(TUI)?.continuationToken).toBe("tui-token-next");
    expect(test.registry.resumeState(VOICE)?.continuationToken).toBe("voice-token-next");
    test.registry.close();
  });

  it("holds a model permit until a streamed response reaches its boundary", async () => {
    const admission = new CaptainAdmissionController({ capacity: 1 });
    let closeStream: (() => void) | undefined;
    const raw = {
      modelId: "fixture",
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<string>({
            start(controller) {
              controller.enqueue("first");
              closeStream = () => controller.close();
            },
          }),
        }),
    };
    const admitted = createAdmittedLanguageModel(raw, {
      admission,
      laneKey: "tui",
      lane: "tui",
      requestId: "stream",
    });
    const response = await admitted.doStream();
    const reader = response.stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: "first" });
    expect(admission.snapshot().active).toEqual(["stream:0"]);
    closeStream?.();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(admission.snapshot().active).toEqual([]);
  });
});
