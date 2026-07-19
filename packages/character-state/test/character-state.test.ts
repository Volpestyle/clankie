import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OptimisticConcurrencyError, SqliteEventStore } from "@clankie/event-store";
import type { DomainEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  BoundedIntentCommandSchema,
  CharacterStateRepository,
  MAX_SHARED_FACTS,
  SharedFactSchema,
  SharedReferenceSchema,
  applyCharacterEvent,
  compareSourcePriority,
  decideIntent,
  emptyCharacterState,
  projectCharacterState,
  sourcePriority,
  toCharacterSnapshot,
  type ArbiterDecision,
  type CharacterSourcePriority,
  type CharacterState,
  type IntentArbiterOptions,
} from "../src/index.ts";

const CHARACTER_ID = "clankie";
const SOURCES = [
  "gameplay_autonomy",
  "ambient_voice",
  "authenticated_tui",
  "safety",
] as const satisfies readonly CharacterSourcePriority[];
const TRUST_SAFETY = {
  isTrustedSystemPrincipal: (principal) =>
    principal.kind === "system" && principal.id.endsWith("safety-principal"),
} satisfies IntentArbiterOptions;

function intent(
  id: string,
  source: CharacterSourcePriority,
  expectedGoalVersion: number,
  offset = 0,
  principalId = `${source}-principal`,
  type: "set_goal" | "steer" = "set_goal",
): unknown {
  const sourceContext = {
    gameplay_autonomy: {
      sourceLane: "gameplay",
      authority: { principal: { kind: "captain", id: principalId }, tier: "autonomous" },
    },
    ambient_voice: {
      sourceLane: "discord_voice",
      authority: { principal: { kind: "human", id: principalId }, tier: "ambient" },
    },
    authenticated_tui: {
      sourceLane: "tui",
      authority: { principal: { kind: "human", id: principalId }, tier: "authenticated" },
    },
    safety: {
      sourceLane: "gameplay",
      authority: { principal: { kind: "system", id: principalId }, tier: "system" },
    },
  } as const;
  return {
    schemaVersion: 1,
    intentId: id,
    characterId: CHARACTER_ID,
    context: {
      ...sourceContext[source],
      correlationId: "character-state-test",
      expectedGoalVersion,
    },
    type,
    ...(type === "set_goal" ? { goal: { kind: "test", summary: `Goal from ${source} (${id})` } } : {}),
    createdAt: new Date(Date.UTC(2026, 6, 11, 12, 0, 0, offset)).toISOString(),
  };
}

function decisionEvent(decision: ArbiterDecision, suffix = "event"): DomainEvent {
  return {
    id: `${decision.intentId}:${suffix}`,
    occurredAt: decision.decidedAt,
    missionId: `character:${decision.characterId}`,
    correlationId: "character-state-test",
    profileHash: "character-state-test-profile",
    type: "character.intent.decided",
    data: { schemaVersion: 1, characterId: decision.characterId, decision },
  };
}

function acceptInto(state: CharacterState, input: unknown): CharacterState {
  const decision = decideIntent(state, input, TRUST_SAFETY);
  expect(decision.status).toBe("accepted");
  return applyCharacterEvent(state, decisionEvent(decision));
}

async function temporaryStore(): Promise<SqliteEventStore> {
  return new SqliteEventStore(await temporaryStorePath());
}

async function temporaryStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "character-state-"));
  return join(directory, "events.db");
}

interface IntentWriterResult {
  ok: boolean;
  decision?: ArbiterDecision;
  error?: { name: string; message: string; code?: string; optimistic: boolean };
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const intentWriter = fileURLToPath(new URL("./fixtures/intent-writer.ts", import.meta.url));

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function startIntentWriter(
  databasePath: string,
  readyPath: string,
  releasePath: string,
  command: unknown,
  expectedRevision: number,
): Promise<IntentWriterResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      resolve(repoRoot, "node_modules/.bin/tsx"),
      [
        intentWriter,
        databasePath,
        readyPath,
        releasePath,
        Buffer.from(JSON.stringify(command), "utf8").toString("base64url"),
        String(expectedRevision),
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Intent writer exited ${String(code)}: ${stderr}\n${stdout}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1);
      if (!line) {
        reject(new Error(`Intent writer returned no result: ${stderr}`));
        return;
      }
      resolvePromise(JSON.parse(line) as IntentWriterResult);
    });
  });
}

async function raceIntents(
  databasePath: string,
  left: unknown,
  right: unknown,
  expectedRevision: number,
): Promise<[IntentWriterResult, IntentWriterResult]> {
  const nonce = crypto.randomUUID();
  const readyLeft = join(tmpdir(), `intent-ready-left-${nonce}`);
  const readyRight = join(tmpdir(), `intent-ready-right-${nonce}`);
  const release = join(tmpdir(), `intent-release-${nonce}`);
  const leftResult = startIntentWriter(databasePath, readyLeft, release, left, expectedRevision);
  await waitForFile(readyLeft);
  const rightResult = startIntentWriter(databasePath, readyRight, release, right, expectedRevision);
  await waitForFile(readyRight);
  await writeFile(release, "go\n", "utf8");
  try {
    return await Promise.all([leftResult, rightResult]);
  } finally {
    await Promise.all([
      rm(readyLeft, { force: true }),
      rm(readyRight, { force: true }),
      rm(release, { force: true }),
    ]);
  }
}

describe("character intent arbitration", () => {
  it("enforces the complete deterministic source-priority ordering", () => {
    for (const activeSource of SOURCES) {
      const active = acceptInto(
        emptyCharacterState(CHARACTER_ID),
        intent(`active-${activeSource}`, activeSource, 0),
      );
      for (const requestedSource of SOURCES) {
        const decision = decideIntent(
          active,
          intent(`requested-${activeSource}-${requestedSource}`, requestedSource, 1, 1),
          TRUST_SAFETY,
        );
        const shouldAccept = compareSourcePriority(requestedSource, activeSource) >= 0;
        expect(decision.status, `${requestedSource} against ${activeSource}`).toBe(
          shouldAccept ? "accepted" : "rejected_policy",
        );
        expect(
          sourcePriority(BoundedIntentCommandSchema.parse(intent("source", requestedSource, 0)).context),
        ).toBe(requestedSource);
      }
    }
  });

  it("increments a TUI replacement exactly once, cancels active work, and rejects stale decisions", () => {
    let state = acceptInto(emptyCharacterState(CHARACTER_ID), intent("autonomy-1", "gameplay_autonomy", 0));
    state = applyCharacterEvent(state, {
      id: "presence-1",
      occurredAt: "2026-07-11T12:00:00.050Z",
      missionId: `character:${CHARACTER_ID}`,
      correlationId: "character-state-test",
      profileHash: "character-state-test-profile",
      type: "character.presence.recorded",
      data: {
        presence: {
          schemaVersion: 1,
          revision: 1,
          characterId: CHARACTER_ID,
          phase: "active",
          goalVersion: 1,
          observedAt: "2026-07-11T12:00:00.050Z",
          sessionId: "paper-1",
          worldId: "frozen-lab",
          activeActionId: "action-1",
        },
      },
    });

    const replacement = decideIntent(state, intent("tui-1", "authenticated_tui", 1, 1));
    expect(replacement).toMatchObject({
      status: "accepted",
      previousGoalVersion: 1,
      nextGoalVersion: 2,
      supersededIntentId: "autonomy-1",
      cancellationIntent: {
        type: "cancel_action",
        actionId: "action-1",
        acceptedGoalVersion: 1,
        replacementGoalVersion: 2,
      },
    });
    state = applyCharacterEvent(state, decisionEvent(replacement));
    expect(state.goalVersion).toBe(2);
    expect(state.revision).toBe(3);

    const stale = decideIntent(state, intent("late-voice-1", "ambient_voice", 1, 2, "speaker", "steer"));
    expect(stale).toMatchObject({
      status: "rejected_stale",
      expectedGoalVersion: 1,
      currentGoalVersion: 2,
    });
    expect(stale.semanticEvents).toContainEqual(
      expect.objectContaining({ type: "captain.intent.rejected_stale" }),
    );
  });

  it("denies caller-supplied safety authority unless a trusted-principal predicate grants it", () => {
    const command = {
      ...(intent("spoofed-system", "ambient_voice", 0) as Record<string, unknown>),
      context: {
        sourceLane: "discord_voice",
        authority: { principal: { kind: "system", id: "trusted-safety" }, tier: "system" },
        correlationId: "character-state-test",
        expectedGoalVersion: 0,
      },
    };

    expect(decideIntent(emptyCharacterState(CHARACTER_ID), command)).toMatchObject({
      status: "rejected_policy",
      reason: expect.stringContaining("trusted system principal") as string,
    });
    expect(
      decideIntent(emptyCharacterState(CHARACTER_ID), command, {
        isTrustedSystemPrincipal: (principal) => principal.id === "trusted-safety",
      }),
    ).toMatchObject({ status: "accepted", sourcePriority: "safety" });
  });

  it("reconstructs ordered decisions and refuses an out-of-order stream", () => {
    const initial = emptyCharacterState(CHARACTER_ID);
    const first = decideIntent(initial, intent("ordered-1", "gameplay_autonomy", 0));
    const afterFirst = applyCharacterEvent(initial, decisionEvent(first, "first"));
    const second = decideIntent(afterFirst, intent("ordered-2", "authenticated_tui", 1, 1));
    const ordered = [decisionEvent(first, "first"), decisionEvent(second, "second")];

    expect(projectCharacterState(ordered, CHARACTER_ID)).toMatchObject({
      schemaVersion: 1,
      revision: 2,
      goalVersion: 2,
      minecraft: { schemaVersion: 1, revision: 0 },
    });
    expect(() => projectCharacterState(ordered.toReversed(), CHARACTER_ID)).toThrow(/next monotonic version/);
  });
});

describe("character event-store discipline", () => {
  it("projects PokeMMO through generic environment presence without rewriting Minecraft v1 state", async () => {
    const store = await temporaryStore();
    const repository = new CharacterStateRepository(store);
    const recorded = await repository.recordEnvironmentPresence(
      {
        schemaVersion: 1,
        revision: 1,
        environmentKind: "pokemmo_simulator",
        characterId: CHARACTER_ID,
        phase: "active",
        goalVersion: 0,
        observedAt: "2026-07-19T00:00:00.000Z",
        sessionId: "pokemmo-session-1",
        worldId: "pokemmo-sim-world-v1",
        position: {
          profile: "pokemmo_simulator",
          value: { mapId: "lab-route", x: 3, y: 1 },
        },
        activeActionId: "pokemmo-action-1",
      },
      0,
      "pokemmo-presence-1",
    );
    expect(recorded.state).toMatchObject({
      minecraft: { phase: "off", revision: 0 },
      environments: [{ environmentKind: "pokemmo_simulator", phase: "active" }],
    });
    expect(toCharacterSnapshot(recorded.state)).toMatchObject({
      activeWorldId: "pokemmo-sim-world-v1",
      activeEnvironmentSessionId: "pokemmo-session-1",
      activeActionId: "pokemmo-action-1",
    });

    const next = await repository.submitIntent(intent("pokemmo-tui-goal", "authenticated_tui", 0), 1);
    expect(next.decision).toMatchObject({
      status: "accepted",
      cancellationIntent: { actionId: "pokemmo-action-1", replacementGoalVersion: 1 },
      semanticEvents: [
        expect.objectContaining({ type: "captain.intent.accepted", sessionId: "pokemmo-session-1" }),
        expect.objectContaining({ type: "pokemmo.goal.changed", sessionId: "pokemmo-session-1" }),
      ],
    });
    await expect(
      repository.recordEnvironmentPresence(
        {
          ...recorded.state.environments[0],
          revision: 2,
          goalVersion: 1,
          position: {
            profile: "minecraft_java",
            value: { x: 0, y: 64, z: 0, dimension: "overworld" },
          },
          observedAt: "2026-07-19T00:00:01.000Z",
        },
        2,
        "forged-position-profile",
      ),
    ).rejects.toThrow(/position profile/);
    store.close();
  });

  it("makes retries idempotent and rejects reuse with a changed payload", async () => {
    const store = await temporaryStore();
    const repository = new CharacterStateRepository(store);
    const command = intent("retry-1", "authenticated_tui", 0);
    const first = await repository.submitIntent(command, 0);
    const replayed = await repository.submitIntent(command, 0);
    expect(replayed.stored).toEqual(first.stored);
    expect(replayed.state).toEqual(first.state);
    expect(replayed.state).toMatchObject({ revision: 1, goalVersion: 1 });
    expect(await store.readStream(`character:${CHARACTER_ID}`)).toHaveLength(1);

    const changed = {
      ...(command as Record<string, unknown>),
      goal: { kind: "changed", summary: "Different content under the same key" },
    };
    await expect(repository.submitIntent(changed, 1)).rejects.toThrow(/reused with a different payload/);
    store.close();
  });

  it("allows only one of two conflicting authenticated principals to commit", async () => {
    const store = await temporaryStore();
    const left = new CharacterStateRepository(store);
    const right = new CharacterStateRepository(store);
    const outcomes = await Promise.allSettled([
      left.submitIntent(intent("human-a", "authenticated_tui", 0, 0, "human-a"), 0),
      right.submitIntent(intent("human-b", "authenticated_tui", 0, 0, "human-b"), 0),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(OptimisticConcurrencyError);
    }
    expect(await left.load(CHARACTER_ID)).toMatchObject({ revision: 1, goalVersion: 1 });
    store.close();
  });

  it("makes higher authority win all synchronized same-version intent races", async () => {
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const path = await temporaryStorePath();
      const seedStore = new SqliteEventStore(path);
      const seedRepository = new CharacterStateRepository(seedStore);
      await seedRepository.submitIntent(intent("seed-gameplay", "gameplay_autonomy", 0), 0);
      seedStore.close();

      const gameplay = intent(
        `gameplay-race-${String(iteration)}`,
        "gameplay_autonomy",
        1,
        iteration + 10,
        "autonomy",
        "steer",
      );
      const tui = intent(`tui-race-${String(iteration)}`, "authenticated_tui", 1, iteration + 30, "human");
      const outcomes = await raceIntents(path, gameplay, tui, 1);
      expect(
        outcomes.every((outcome) => outcome.ok),
        `iteration ${String(iteration)}: ${JSON.stringify(outcomes)}`,
      ).toBe(true);

      const gameplayDecision = outcomes[0]?.decision;
      const tuiDecision = outcomes[1]?.decision;
      expect(tuiDecision, `iteration ${String(iteration)}`).toMatchObject({
        status: "accepted",
        sourcePriority: "authenticated_tui",
      });
      expect(["accepted", "rejected_stale"]).toContain(gameplayDecision?.status);
      if (gameplayDecision?.status === "accepted") {
        expect(tuiDecision).toMatchObject({
          invalidatedIntentIds: [gameplayDecision.intentId],
        });
      }

      const reopened = new SqliteEventStore(path);
      const repository = new CharacterStateRepository(reopened);
      const state = await repository.load(CHARACTER_ID);
      const events = (await reopened.readStream(`character:${CHARACTER_ID}`)).map((entry) => entry.event);
      expect(state).toMatchObject({
        goalVersion: 2,
        activeGoal: { sourcePriority: "authenticated_tui" },
      });
      expect(projectCharacterState(events, CHARACTER_ID)).toEqual(state);
      reopened.close();
    }
  }, 30_000);

  it("invalidates a committed lower-priority command when higher authority arrives second", async () => {
    const store = await temporaryStore();
    const repository = new CharacterStateRepository(store);
    await repository.submitIntent(intent("seed", "gameplay_autonomy", 0), 0);
    const gameplay = await repository.submitIntent(
      intent("gameplay-first", "gameplay_autonomy", 1, 1, "autonomy", "steer"),
      1,
    );
    expect(gameplay.decision.status).toBe("accepted");

    const tui = await repository.submitIntent(intent("tui-second", "authenticated_tui", 1, 2), 2);
    expect(tui.decision).toMatchObject({
      status: "accepted",
      sourcePriority: "authenticated_tui",
      invalidatedIntentIds: ["gameplay-first"],
      semanticEvents: [
        expect.objectContaining({ type: "captain.intent.accepted" }),
        expect.objectContaining({ type: "minecraft.goal.changed" }),
        expect.objectContaining({
          type: "minecraft.goal.superseded",
          data: expect.objectContaining({ supersededIntentId: "seed" }) as unknown,
        }),
        expect.objectContaining({
          type: "captain.lane.preempted",
          data: expect.objectContaining({ invalidatedIntentId: "gameplay-first" }) as unknown,
        }),
      ],
    });
    expect(tui.state).toMatchObject({
      goalVersion: 2,
      activeGoal: { intentId: "tui-second" },
      activeIntents: [],
    });
    store.close();
  });

  it("reconstructs an identical projection from the frozen replay timeline", async () => {
    const timeline = JSON.parse(
      await readFile(new URL("./fixtures/replay-timeline.json", import.meta.url), "utf8"),
    ) as Array<{
      kind: "intent" | "presence";
      expectedRevision: number;
      idempotencyKey?: string;
      value: unknown;
    }>;

    const execute = async (): Promise<{ state: CharacterState; events: DomainEvent[] }> => {
      const store = await temporaryStore();
      const repository = new CharacterStateRepository(store);
      for (const operation of timeline) {
        if (operation.kind === "intent") {
          await repository.submitIntent(operation.value, operation.expectedRevision);
        } else {
          await repository.recordPresence(
            operation.value,
            operation.expectedRevision,
            operation.idempotencyKey ?? "missing",
          );
        }
      }
      const entries = await store.readStream(`character:${CHARACTER_ID}`);
      const result = {
        state: await repository.load(CHARACTER_ID),
        events: entries.map((entry) => entry.event),
      };
      store.close();
      return result;
    };

    const first = await execute();
    const second = await execute();
    expect(second).toEqual(first);
    expect(projectCharacterState(first.events, CHARACTER_ID)).toEqual(first.state);
    expect(first.state).toMatchObject({ revision: 4, goalVersion: 2 });
    expect(first.state.lastDecision).toMatchObject({ status: "rejected_stale", currentGoalVersion: 2 });
  });
});

describe("bounded shared character memory", () => {
  it("rejects raw private fields and deterministically evicts old facts", async () => {
    const baseFact = {
      factId: "fact-0",
      key: "home",
      value: "Oak shelter is at spawn",
      observedAt: "2026-07-11T12:00:00.000Z",
      sourceEventId: "source-0",
    };
    expect(() => SharedFactSchema.parse({ ...baseFact, transcript: "raw voice" })).toThrow();
    expect(() => SharedFactSchema.parse({ ...baseFact, reasoning: "private chain" })).toThrow();
    for (const [field, value] of [
      ["key", "TRANSCRIPT"],
      ["value", "Raw voice transcript: private phrase"],
      ["value", "Reasoning: hidden chain-of-thought"],
      ["sourceEventId", "continuation-token://private"],
      ["value", "ACCESS_TOKEN:private"],
    ] as const) {
      const result = SharedFactSchema.safeParse({ ...baseFact, [field]: value });
      expect(result.success, `${field}=${value}`).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/shared memory.*private/i);
      }
    }
    for (const input of [
      {
        referenceId: "private-reference",
        kind: "attention",
        uri: "continuation-token://secret-token-value",
        summary: "bounded summary",
        observedAt: "2026-07-11T12:00:00.000Z",
        sourceEventId: "source-reference",
      },
      {
        referenceId: "private-reference",
        kind: "attention",
        uri: "artifact://safe",
        summary: "Reasoning: private chain-of-thought content",
        observedAt: "2026-07-11T12:00:00.000Z",
        sourceEventId: "source-reference",
      },
    ]) {
      const result = SharedReferenceSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/shared memory.*private/i);
      }
    }
    expect(() =>
      BoundedIntentCommandSchema.parse({
        ...(intent("private-goal", "authenticated_tui", 0) as Record<string, unknown>),
        goal: { kind: "test", summary: "bounded", reasoning: "private chain" },
      }),
    ).toThrow();

    const store = await temporaryStore();
    const repository = new CharacterStateRepository(store);
    for (let index = 0; index < MAX_SHARED_FACTS + 2; index += 1) {
      await repository.recordFact(
        CHARACTER_ID,
        {
          ...baseFact,
          factId: `fact-${String(index)}`,
          value: `bounded fact ${String(index)}`,
          sourceEventId: `source-${String(index)}`,
          observedAt: new Date(Date.UTC(2026, 6, 11, 12, 0, 0, index)).toISOString(),
        },
        index,
        `fact-write-${String(index)}`,
      );
    }
    const state = await repository.load(CHARACTER_ID);
    expect(state.sharedFacts).toHaveLength(MAX_SHARED_FACTS);
    expect(state.sharedFacts[0]?.factId).toBe("fact-2");
    expect(toCharacterSnapshot(state).sharedMemoryRefs).toHaveLength(MAX_SHARED_FACTS);
    expect(toCharacterSnapshot(state)).toEqual(toCharacterSnapshot(await repository.load(CHARACTER_ID)));
    store.close();
  });
});
