import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ScenarioBindingSchema, ScenarioReportSchema, verifierGoalEvent } from "../src/contracts.ts";

const hash = "177331287aa35f03ed6e887e74e510bd675881e53f2a759c36f3a184877199ea";
const binding = {
  schemaVersion: 1,
  environment: {
    schemaVersion: 1,
    environmentKind: "minecraft_java",
    characterId: "clankie",
    worldId: "private-paper-world",
    lane: "gameplay",
    environmentSessionId: "minecraft-session-1",
  },
  scenarioId: "collect-craft-place",
  scenarioVersion: 1,
  fixtureSha256: hash,
};

const report = {
  schemaVersion: 1,
  scenarioId: "collect-craft-place",
  scenarioVersion: 1,
  fixtureSha256: hash,
  runId: "run-1",
  result: "passed",
  startedAt: "2026-07-11T12:00:00.000Z",
  endedAt: "2026-07-11T12:00:01.000Z",
  durationMs: 1_000,
  startingStateSha256: hash,
  eventChainHeadSha256: hash,
  checks: { logs: true, crafted: true, placed: true, alive: true, policy: true },
  finalState: {
    playerName: "Clankie",
    alive: true,
    health: 20,
    gameMode: "SURVIVAL",
    collectedLogs: 8,
    craftedTable: true,
    placedTableInTarget: true,
    actualPlacedBlock: "CRAFTING_TABLE",
    inventory: {},
    violations: [],
  },
  artifacts: [
    { kind: "event_log", path: "events.jsonl", sha256: hash },
    { kind: "report", path: "report.json", sha256: hash },
  ],
};

describe("Paper verifier frozen-contract adapter", () => {
  it("validates the committed binding against frozen v1 identity contracts", () => {
    const committed = JSON.parse(
      readFileSync(
        new URL("../../../scenarios/minecraft/collect-craft-place/v1/binding.json", import.meta.url),
        "utf8",
      ),
    );
    expect(ScenarioBindingSchema.parse(committed)).toMatchObject({
      scenarioId: "collect-craft-place",
      fixtureSha256: hash,
      environment: { worldId: "private-paper-world", lane: "gameplay" },
    });
  });

  it("emits a frozen v1 semantic event for a matching authoritative report", () => {
    expect(verifierGoalEvent(report, binding, "2026-07-11T12:00:02.000Z")).toMatchObject({
      schemaVersion: 1,
      type: "minecraft.goal.verified",
      sessionId: "minecraft-session-1",
    });
  });

  it("rejects fake success when an authoritative check is false", () => {
    expect(() =>
      ScenarioReportSchema.parse({ ...report, checks: { ...report.checks, placed: false } }),
    ).toThrow(/authoritative checks/);
  });

  it("rejects a report for another fixture", () => {
    expect(() => verifierGoalEvent({ ...report, fixtureSha256: "b".repeat(64) }, binding)).toThrow(
      /frozen scenario binding/,
    );
  });
});
