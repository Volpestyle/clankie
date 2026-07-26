import { readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  acquireBodyLock,
  FrozenGbaScenarioSchema,
  RealGbaRouteScenarioSchema,
  sha256,
  type BootedGbaGame,
  type GbaAdapterScenario,
} from "@clankie/gba-emulator";
import type {
  EmbodimentAssignment,
  EmbodimentClaim,
  EmbodimentLifecycleReport,
  EmbodimentSession,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createGbaPlayExecution } from "../src/play-execution.ts";
import { PlayHost } from "../src/play-host.ts";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A mind with no model: press A, forever. The loop, not the play, is under test. */
const buttonMasher = () =>
  Promise.resolve({
    decide: () =>
      Promise.resolve({
        monologue: "pressing on",
        intent: "press a",
        action: { kind: "button_press", button: "a", holdFrames: 2 },
      }),
  });

function fakeClient(assignment: EmbodimentAssignment) {
  const assignments = [assignment];
  const reports: EmbodimentLifecycleReport[] = [];
  return {
    reports,
    claimEmbodiment(_claim: EmbodimentClaim): Promise<EmbodimentAssignment | undefined> {
      return Promise.resolve(assignments.shift());
    },
    reportEmbodiment(report: EmbodimentLifecycleReport): Promise<unknown> {
      reports.push(report);
      return Promise.resolve({});
    },
    getLiveEmbodimentSession(): Promise<EmbodimentSession | undefined> {
      return Promise.resolve(undefined);
    },
  };
}

function session(): EmbodimentSession {
  return {
    schemaVersion: 1,
    sessionId: "round-trip-1",
    environmentId: "pokemon-firered",
    state: "claimed",
    intentId: "intent-1",
    originLane: "discord_presence",
    requestedBy: "user-1",
    budget: { maxTurns: 2, maxDurationMs: 60_000 },
    requestedAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:01.000Z",
    runnerId: "runner-local",
  };
}

async function playEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-play-round-trip-"));
  return {
    CLANKIE_GBA_BODY_ROOT: join(root, "body"),
    CLANKIE_GBA_CHECKPOINT_DIR: join(root, "checkpoints"),
    CLANKIE_ACTIVITY_PRODUCER_URL: "ws://127.0.0.1:1/producer",
  };
}

describe("asked play round trip on the deterministic double", () => {
  it("claims, runs the budgeted turns for real, and reports the receipt", async () => {
    const client = fakeClient({ kind: "start", session: session() });
    const host = new PlayHost({
      client,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env: await playEnv(),
        createMind: buttonMasher,
      }),
      logger: silentLogger,
    });
    expect(await host.poll()).toBe(true);
    await host.settled();
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    const receipt = client.reports[1]?.receipt;
    expect(receipt).toMatchObject({ outcome: "budget_exhausted", turnsTaken: 2 });
  });

  it("mints a checkpoint on stop and resumes from it on the next ask", async () => {
    // The double has no checkpoint capability by design, so the capability is
    // faked around the REAL mint/read gates: writeGbaCheckpoint and
    // readGbaCheckpoint run unchanged, including their identity and digest
    // fail-closed checks. Only the core's saveState/loadState are stand-ins.
    const require = createRequire(import.meta.url);
    const emulatorPackage = dirname(require.resolve("@clankie/gba-emulator/package.json"));
    const repoRoot = resolve(emulatorPackage, "../..");
    const doubleBytes = readFileSync(
      join(repoRoot, "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json"),
    );
    const doubleScenario = FrozenGbaScenarioSchema.parse(
      JSON.parse(doubleBytes.toString("utf8")),
    ) as GbaAdapterScenario;
    const routeScenario = RealGbaRouteScenarioSchema.parse(
      JSON.parse(
        readFileSync(join(emulatorPackage, "fixtures/firered-bedroom-route/v1/scenario.json"), "utf8"),
      ),
    );
    const savedBytes = new TextEncoder().encode("fake-savestate-run-one");
    const loaded: Uint8Array[] = [];
    const fakeBoot = (): Promise<BootedGbaGame> =>
      Promise.resolve({
        scenario: doubleScenario,
        fixtureSha256: sha256(doubleBytes),
        coreFactory: undefined,
        checkpoints: {
          saveState: () => savedBytes,
          loadState: (bytes: Uint8Array) => {
            loaded.push(bytes);
          },
          identity: {
            romSha256: routeScenario.romSha256,
            savestateSha256: routeScenario.savestateSha256,
            coreWasmSha256: routeScenario.coreWasmSha256,
          },
          scenario: routeScenario,
        },
        framePng: () => null,
        observeFrames: () => undefined,
        framebufferSha256: () => null,
        real: false,
      });
    const env = await playEnv();

    const first = fakeClient({ kind: "start", session: session() });
    const firstHost = new PlayHost({
      client: first,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: buttonMasher,
        boot: fakeBoot,
      }),
      logger: silentLogger,
    });
    await firstHost.poll();
    await firstHost.settled();
    expect(first.reports[0]).toMatchObject({ state: "running" });
    expect(first.reports[0]?.resumedFromCheckpointId).toBeUndefined();
    const mintedId = first.reports[1]?.receipt?.checkpointId;
    expect(mintedId).toBeDefined();

    const second = fakeClient({ kind: "start", session: session() });
    const secondHost = new PlayHost({
      client: second,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: buttonMasher,
        boot: fakeBoot,
      }),
      logger: silentLogger,
    });
    await secondHost.poll();
    await secondHost.settled();
    expect(second.reports[0]).toMatchObject({
      state: "running",
      resumedFromCheckpointId: mintedId,
    });
    expect(second.reports[1]?.receipt).toMatchObject({ resumedFromCheckpointId: mintedId });
    // The exact minted savestate bytes reached the core, digest-verified.
    expect(loaded).toHaveLength(1);
    expect(Buffer.from(loaded[0] as Uint8Array).equals(Buffer.from(savedBytes))).toBe(true);
  });

  it("refuses body_held when another process holds the body lock", async () => {
    const env = await playEnv();
    await mkdir(env["CLANKIE_GBA_BODY_ROOT"] as string, { recursive: true });
    const lock = acquireBodyLock({
      rootDir: env["CLANKIE_GBA_BODY_ROOT"] as string,
      holderId: "claude-code-possession",
    });
    try {
      const client = fakeClient({ kind: "start", session: session() });
      const host = new PlayHost({
        client,
        runnerId: "runner-local",
        environmentIds: ["pokemon-firered"],
        execute: createGbaPlayExecution({ logger: silentLogger, env, createMind: buttonMasher }),
        logger: silentLogger,
      });
      await host.poll();
      await host.settled();
      expect(client.reports).toEqual([
        expect.objectContaining({ state: "refused", refusalReason: "body_held" }),
      ]);
    } finally {
      lock.release();
    }
  });
});
