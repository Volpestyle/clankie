import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FrozenGbaScenarioSchema } from "../src/contracts.ts";
import { sha256 } from "../src/core-double.ts";
import { defaultGbaRuntimeRootDir } from "../src/free-play-boot.ts";
import { createFreePlaySession } from "../src/free-play-session.ts";

const require = createRequire(import.meta.url);
const emulatorPackage = path.dirname(require.resolve("@clankie/gba-emulator/package.json"));
const scenarioPath = path.resolve(
  emulatorPackage,
  "../..",
  "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
);
const scenarioBytes = readFileSync(scenarioPath);
const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(scenarioBytes.toString("utf8")));
const fixtureSha256 = sha256(scenarioBytes);

describe("invocation-local runtimes", () => {
  it("can use a harness identity without mutating the digest-validated scenario", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "gba-harness-identity-"));
    const session = await createFreePlaySession({
      rootDir,
      scenario,
      fixtureSha256,
      characterId: "gba-mcp-harness",
      holderId: "gba-mcp-harness",
    });
    expect(session.io.observe("overworld").characterId).toBe("gba-mcp-harness");
    expect(await session.io.act({ kind: "button_press", button: "a", holdFrames: 4 })).toMatchObject({
      status: "completed",
    });
    await session.close();
  });

  it("starts and acts independently under one state parent without loading sibling records", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "gba-runtimes-"));
    const input = { rootDir, scenario, fixtureSha256, runId: "same-session-id" };
    const first = await createFreePlaySession(input);
    const second = await createFreePlaySession(input);

    // Matching session and action ids would collide immediately if either
    // runtime loaded records from the other's child directory.
    expect(second.sessionId).toBe(first.sessionId);
    const [firstResult, secondResult] = await Promise.all([
      first.io.act({ kind: "button_press", button: "a", holdFrames: 4 }),
      second.io.act({ kind: "button_press", button: "b", holdFrames: 4 }),
    ]);
    expect(firstResult.status).toBe("completed");
    expect(secondResult.status).toBe("completed");

    const runtimeDirs = readdirSync(rootDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(runtimeDirs).toHaveLength(2);
    for (const runtimeDir of runtimeDirs) {
      expect(
        readdirSync(path.join(rootDir, runtimeDir.name, "environment-sessions")).filter((name) =>
          name.endsWith(".json"),
        ),
      ).toHaveLength(1);
    }

    await first.close();
    await first.close();
    expect(
      first.events.filter((event) => "type" in event && event.type === "environment.session.stopped"),
    ).toHaveLength(1);
    await expect(first.io.act({ kind: "button_press", button: "a", holdFrames: 4 })).rejects.toThrow(
      /revoked/,
    );
    await second.close();
    expect(readdirSync(rootDir)).toEqual([]);
  });

  it("removes runtime state and preserves a persistence error from close", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "gba-close-failure-"));
    const session = await createFreePlaySession({ rootDir, scenario, fixtureSha256 });
    const runtimeRoot = path.join(rootDir, readdirSync(rootDir)[0]!);
    const recordsDir = path.join(runtimeRoot, "environment-sessions");
    rmSync(recordsDir, { recursive: true });
    writeFileSync(recordsDir, "blocks persistence");

    let closeError: unknown;
    try {
      await session.close();
    } catch (error) {
      closeError = error;
    }
    expect(closeError).toMatchObject({ code: "EEXIST" });
    expect(readdirSync(rootDir)).toEqual([]);
    await expect(session.close()).rejects.toBe(closeError);
  });

  it("resolves a neutral XDG state parent", () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "state-"));
    const env = { XDG_STATE_HOME: stateRoot } as NodeJS.ProcessEnv;
    expect(defaultGbaRuntimeRootDir(env)).toBe(path.join(stateRoot, "clankie", "gba-runtime"));
  });
});

describe("lease lapse recovery", () => {
  it("self-heals an act when thinking between moves outlives the lease", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "lease-lapse-"));
    const now = { value: new Date("2026-07-19T00:00:00.000Z") };
    const session = await createFreePlaySession({
      rootDir,
      scenario,
      fixtureSha256,
      clock: () => now.value,
    });
    const first = await session.io.act({ kind: "button_press", button: "a", holdFrames: 4 });
    expect(first.status).toBe("completed");
    // Six minutes of deliberation outlives the five-minute lease. The lapse
    // paused the body in place, so the next act renews and continues — the
    // session is not bricked and the world is not reset.
    now.value = new Date("2026-07-19T00:06:00.000Z");
    const second = await session.io.act({ kind: "button_press", button: "a", holdFrames: 4 });
    expect(second.status).toBe("completed");
    const types = session.events.map((event) => ("type" in event ? event.type : ""));
    expect(types).toContain("environment.session.lease_expired");
    expect(types).toContain("environment.session.lease_renewed");
    await session.close();
  });

  it("recovers pause and resume across a lapse without undoing a deliberate pause", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "lease-lapse-pause-"));
    const now = { value: new Date("2026-07-19T00:00:00.000Z") };
    const session = await createFreePlaySession({
      rootDir,
      scenario,
      fixtureSha256,
      clock: () => now.value,
    });
    await session.io.pause("state looks uncertain");
    now.value = new Date("2026-07-19T00:06:00.000Z");
    // The lapse must not silently undo the safety pause: acting still requires
    // an explicit resume from the mind that judged the state safe again.
    await expect(session.io.act({ kind: "button_press", button: "a", holdFrames: 4 })).rejects.toThrow(
      /not active/,
    );
    await session.io.resume();
    const result = await session.io.act({ kind: "button_press", button: "a", holdFrames: 4 });
    expect(result.status).toBe("completed");
    await session.close();
  });
});

describe("per-run session identity", () => {
  it("gives successive playthroughs distinct identities", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "per-run-"));
    const first = await createFreePlaySession({ rootDir, scenario, fixtureSha256 });
    await first.io.act({ kind: "button_press", button: "a", holdFrames: 4 });
    await first.close();
    const second = await createFreePlaySession({ rootDir, scenario, fixtureSha256 });
    await second.io.act({ kind: "button_press", button: "a", holdFrames: 4 });
    await second.close();
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(first.sessionId).toMatch(/^gba-free-play:.+:v\d+:/u);
  });
});
