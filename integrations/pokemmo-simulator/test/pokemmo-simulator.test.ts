import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PokeMMOSimulatorSessionSpecSchema,
  type EnvironmentEvent,
  type PokeMMOSimulatorAction,
  type PokeMMOStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentRuntime } from "@clankie/environment-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrozenPokeMMOScenarioSchema,
  PokeMMOScenarioBindingSchema,
  PokeMMOScenarioReportSchema,
  PokeMMOSimulatorAdapter,
  pokemmoSimulatorGoalEvent,
  runFrozenPokeMMOScenario,
  validatePokeMMOSimulatorTrace,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const fixtureRoot = resolve(import.meta.dirname, "../../../scenarios/pokemmo/navigation-trainer-battle/v1");

async function fixture() {
  const bytes = await readFile(resolve(fixtureRoot, "scenario.json"));
  const fixtureSha256 = createHash("sha256").update(bytes).digest("hex");
  const scenario = FrozenPokeMMOScenarioSchema.parse(JSON.parse(bytes.toString("utf8")));
  const binding = PokeMMOScenarioBindingSchema.parse(
    JSON.parse(await readFile(resolve(fixtureRoot, "binding.json"), "utf8")),
  );
  return { binding, fixtureSha256, scenario };
}

const allCapabilities = [
  "pokemmo.simulator.observe",
  "pokemmo.simulator.navigate",
  "pokemmo.simulator.interact",
  "pokemmo.simulator.menu",
  "pokemmo.simulator.battle",
  "pokemmo.simulator.party",
  "pokemmo.simulator.inventory",
  "pokemmo.simulator.wait",
] as const;

async function harness() {
  const frozen = await fixture();
  const rootDir = await mkdtemp(join(tmpdir(), "pokemmo-simulator-test-"));
  roots.push(rootDir);
  const adapter = new PokeMMOSimulatorAdapter(frozen.scenario, frozen.fixtureSha256);
  const events: EnvironmentEvent[] = [];
  const now = { value: new Date("2026-07-19T00:00:00.000Z") };
  const runtime = new EnvironmentRuntime({
    rootDir,
    adapter,
    events: { append: (event) => (events.push(event), Promise.resolve()) },
    clock: () => now.value,
    randomToken: () => "private-grant-marker",
  });
  const spec = PokeMMOSimulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId: "pokemmo-test-session",
    environmentKind: "pokemmo_simulator",
    characterId: frozen.scenario.player.characterId,
    worldId: frozen.scenario.worldId,
    requestedBy: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "pokemmo_simulator",
      simulatorId: frozen.scenario.simulatorId,
      worldId: frozen.scenario.worldId,
      characterId: frozen.scenario.player.characterId,
      allowedMapIds: [frozen.scenario.map.mapId],
      maxNavigationStepsPerAction: 64,
      maxMenuChoicesPerAction: 8,
      maxBattleTurnsPerAction: 16,
      maxActionDurationMs: 5_000,
      capabilities: allCapabilities,
    },
  });
  const grant = await runtime.start({
    spec,
    holderId: "runner",
    correlationId: "pokemmo-test",
    leaseDurationMs: 10_000,
  });
  const command = (
    actionId: string,
    action: PokeMMOSimulatorAction,
    expectedGoalVersion = 1,
  ): PokeMMOStartActionCommand => ({
    schemaVersion: 1,
    commandId: `command-${actionId}`,
    type: "start_action",
    requestedAt: "2026-07-19T00:00:00.000Z",
    context: {
      sourceLane: "gameplay",
      authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
      correlationId: `correlation-${actionId}`,
      expectedGoalVersion,
    },
    sessionId: spec.sessionId,
    actionId,
    action: {
      kind: "pokemmo_simulator_action",
      action,
      limits: { maxSteps: 64, maxMenuChoices: 8, maxBattleTurns: 16, timeoutMs: 5_000 },
    },
  });
  return { ...frozen, adapter, command, events, grant, now, rootDir, runtime, spec };
}

describe("PokeMMO deterministic simulator", () => {
  it("completes the frozen navigation and trainer-battle scenario deterministically", async () => {
    const frozen = await fixture();
    const firstRoot = await mkdtemp(join(tmpdir(), "pokemmo-scenario-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "pokemmo-scenario-second-"));
    roots.push(firstRoot, secondRoot);
    const first = await runFrozenPokeMMOScenario({ rootDir: firstRoot, ...frozen });
    const second = await runFrozenPokeMMOScenario({ rootDir: secondRoot, ...frozen });
    expect(first.report).toEqual(second.report);
    expect(first.trace).toEqual(second.trace);
    expect(first.report).toMatchObject({
      result: "passed",
      checks: {
        targetLocationReached: true,
        trainerBattleEntered: true,
        legalMovesSelected: true,
        trainerBattleWon: true,
        authoritativeStateCertain: true,
        evidenceBounded: true,
      },
      finalState: { battleResult: "won", opponentHp: 0 },
    });
    expect(first.trace.events).toHaveLength(5);
    expect(first.goalEvent).toMatchObject({ type: "pokemmo.goal.verified" });
    expect(() =>
      validatePokeMMOSimulatorTrace({
        ...first.trace,
        events: first.trace.events.map((event, index) =>
          index === 0 ? { ...event, summary: "tampered evidence" } : event,
        ),
      }),
    ).toThrow(/event hash/);
  });

  it("derives success only from a matching frozen binding and authoritative checks", async () => {
    const frozen = await fixture();
    const rootDir = await mkdtemp(join(tmpdir(), "pokemmo-scenario-contract-"));
    roots.push(rootDir);
    const { report } = await runFrozenPokeMMOScenario({ rootDir, ...frozen });
    expect(PokeMMOScenarioReportSchema.parse(report)).toEqual(report);
    expect(() =>
      PokeMMOScenarioReportSchema.parse({
        ...report,
        checks: { ...report.checks, trainerBattleWon: false },
      }),
    ).toThrow(/authoritative checks/);
    expect(() =>
      pokemmoSimulatorGoalEvent({ ...report, fixtureSha256: "b".repeat(64) }, frozen.binding),
    ).toThrow(/frozen scenario binding/);
  });

  it("does not repeat duplicate action side effects and rejects stale goals before dispatch", async () => {
    const { adapter, command, grant, runtime, spec } = await harness();
    const navigate = command("navigate-once", {
      kind: "navigate",
      target: { mapId: "lab-route", x: 3, y: 1 },
    });
    const first = await runtime.startAction(grant.token, navigate);
    const duplicate = await runtime.startAction(grant.token, navigate);
    expect(duplicate).toEqual(first);
    expect(adapter.session(spec.sessionId).trace().events).toHaveLength(1);
    const stale = await runtime.startAction(
      grant.token,
      command("stale-action", { kind: "interact", targetId: "trainer-sage" }, 0),
    );
    expect(stale).toMatchObject({ status: "stale", expectedGoalVersion: 0, currentGoalVersion: 1 });
    expect(adapter.session(spec.sessionId).trace().events).toHaveLength(1);
  });

  it("fails uncertain state closed without a retryable input path", async () => {
    const { adapter, command, grant, runtime, spec } = await harness();
    adapter.session(spec.sessionId).markStateUncertain("Observation sequence gap");
    const result = await runtime.startAction(
      grant.token,
      command("uncertain-action", { kind: "navigate", target: { mapId: "lab-route", x: 1, y: 1 } }),
    );
    expect(result).toMatchObject({ status: "failed", errorCode: "uncertain_state", retryable: false });
    expect(adapter.session(spec.sessionId).snapshot().position).toMatchObject({ x: 0, y: 1 });
    expect(adapter.session(spec.sessionId).observe("danger")).toMatchObject({
      data: { code: "uncertain_state", stateCertain: false },
    });
  });

  it("supports menu choice, party switch, item use, and bounded battle turns", async () => {
    const { adapter, command, grant, runtime, scenario, spec } = await harness();
    await expect(
      runtime.startAction(
        grant.token,
        command("menu", { kind: "menu_choice", menuId: "field-menu", choiceId: "party" }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    await runtime.startAction(
      grant.token,
      command("navigate", { kind: "navigate", target: scenario.targetLocation }),
    );
    await runtime.startAction(
      grant.token,
      command("interact", { kind: "interact", targetId: scenario.trainer.trainerId }),
    );
    let battle = adapter.session(spec.sessionId).observe("battle");
    if (battle.kind !== "battle") throw new Error("Expected battle observation");
    await expect(
      runtime.startAction(
        grant.token,
        command("switch", {
          kind: "party_switch",
          battleId: battle.data.battleId,
          partySlot: 1,
          expectedTurn: battle.data.turn,
        }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    battle = adapter.session(spec.sessionId).observe("battle");
    if (battle.kind !== "battle") throw new Error("Expected battle observation");
    await expect(
      runtime.startAction(
        grant.token,
        command("item", {
          kind: "item_use",
          itemId: "potion",
          targetPartySlot: 1,
          battleId: battle.data.battleId,
          expectedTurn: battle.data.turn,
        }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(adapter.session(spec.sessionId).observe("inventory")).toMatchObject({
      data: { items: [{ itemId: "potion", count: 0 }] },
    });
  });

  it("cancels pending work and fails closed on lease loss and emergency stop", async () => {
    const first = await harness();
    const waiting = await first.runtime.startAction(
      first.grant.token,
      first.command("wait", { kind: "wait", durationMs: 1_000 }),
    );
    expect(waiting).toMatchObject({ status: "running" });
    await expect(
      first.runtime.cancelAction(first.grant.token, first.spec.sessionId, "wait", "operator cancel"),
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(first.adapter.session(first.spec.sessionId).trace().events.at(-1)).toMatchObject({
      actionKind: "cancel_action",
    });

    const second = await harness();
    await second.runtime.startAction(
      second.grant.token,
      second.command("lease-wait", { kind: "wait", durationMs: 1_000 }),
    );
    second.now.value = new Date("2026-07-19T00:00:11.000Z");
    expect(await second.runtime.sweep()).toMatchObject({ expiredSessions: [second.spec.sessionId] });
    await expect(
      second.runtime.startAction(
        second.grant.token,
        second.command("after-lease", { kind: "navigate", target: { mapId: "lab-route", x: 1, y: 1 } }),
      ),
    ).rejects.toThrow(/revoked/);

    const third = await harness();
    await third.runtime.startAction(
      third.grant.token,
      third.command("emergency-wait", { kind: "wait", durationMs: 1_000 }),
    );
    await expect(
      third.runtime.emergencyStop(third.spec.sessionId, "operator emergency"),
    ).resolves.toMatchObject({
      phase: "off",
    });
    expect(third.adapter.session(third.spec.sessionId).snapshot().position).toMatchObject({ x: 0, y: 1 });
  });

  it("rejects credentials at the simulator boundary and keeps them out of state and events", async () => {
    const { adapter, events, spec } = await harness();
    const separateRoot = await mkdtemp(join(tmpdir(), "pokemmo-credential-test-"));
    roots.push(separateRoot);
    const runtime = new EnvironmentRuntime({
      rootDir: separateRoot,
      adapter,
      events: { append: (event) => (events.push(event), Promise.resolve()) },
      randomToken: () => "credential-test-grant",
    });
    await expect(
      runtime.start({
        spec: { ...spec, sessionId: "credential-session" },
        holderId: "runner",
        correlationId: "credential-marker",
        connection: { password: "credential-marker" },
      }),
    ).rejects.toThrow(/failed to start/);
    const records = await readdir(resolve(separateRoot, "environment-sessions"));
    const retained = await Promise.all(
      records.map((record) => readFile(resolve(separateRoot, "environment-sessions", record), "utf8")),
    );
    expect(JSON.stringify({ events, retained })).not.toContain("credential-marker");
  });
});
