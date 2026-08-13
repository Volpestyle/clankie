import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";
import { nextFireAfter, parseCronExpression } from "../src/mission-triggers.ts";

let doctrine: ReturnType<typeof compileDoctrine>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

describe("five-field cron evaluator", () => {
  it("supports wildcard, number, lists, and wildcard steps in UTC", () => {
    expect(
      nextFireAfter(
        { kind: "cron", expression: "*/15 9,17 * 1,7 1" },
        new Date("2026-07-12T18:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-07-13T09:00:00.000Z");
    expect(
      nextFireAfter(
        { kind: "cron", expression: "5 * * * *" },
        new Date("2026-07-12T10:05:00Z"),
      )?.toISOString(),
    ).toBe("2026-07-12T11:05:00.000Z");
  });

  it("rejects ranges, names, malformed steps, and out-of-range values", () => {
    for (const expression of ["0-5 * * * *", "0 noon * * *", "*/0 * * * *", "60 * * * *", "* * * *"]) {
      expect(() => parseCronExpression(expression), expression).toThrow(/Cron|Unsupported|Invalid|between/u);
    }
  });
});

describe("mission trigger control plane", () => {
  it("fires at most one late mission and carries compiled doctrine budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-trigger-"));
    const store = new SqliteEventStore(join(root, "events.db"));
    let now = new Date("2026-07-12T00:00:00.000Z");
    let nextId = 0;
    const app = await createControlPlane({
      doctrine,
      eventStore: store,
      clock: () => now,
      idFactory: () => `deterministic-${String(++nextId).padStart(4, "0")}`,
      authenticateOperator: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer operator"
            ? { operatorId: "operator-test" }
            : undefined,
        ),
    });
    const create = await app.request("/v1/mission-triggers", {
      method: "POST",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({
        id: "recurring",
        goal: "Review dependency health",
        context: { source: "scheduled-test" },
        schedule: { kind: "cron", expression: "* * * * *" },
        misfirePolicy: "run_once_late",
      }),
    });
    expect(create.status).toBe(201);

    now = new Date("2026-07-12T00:05:00.000Z");
    const evaluated = await app.request("/v1/mission-triggers/evaluate", {
      method: "POST",
      headers: { authorization: "Bearer operator" },
    });
    await expect(evaluated.json()).resolves.toEqual({ fired: ["recurring"], skipped: [] });
    const events = await store.readAll();
    const fired = events.find((entry) => entry.event.type === "mission.trigger.fired")?.event;
    expect(fired).toBeDefined();
    const missionId = fired?.data.missionId;
    expect(typeof missionId).toBe("string");
    const mission = await (await app.request(`/v1/missions/${String(missionId)}`)).json();
    expect(mission).toMatchObject({
      goal: "Review dependency health",
      context: {
        source: "scheduled-test",
        scheduledTrigger: { triggerId: "recurring", scheduledAt: "2026-07-12T00:01:00.000Z" },
        doctrineBudgets: {
          maxMissionCostUsd: 5,
          maxMissionWallMinutes: 30,
          maxParallelWorkers: 3,
        },
      },
    });
    const second = await app.request("/v1/mission-triggers/evaluate", {
      method: "POST",
      headers: { authorization: "Bearer operator" },
    });
    await expect(second.json()).resolves.toEqual({ fired: [], skipped: [] });
    expect(
      (await store.readAll()).filter((entry) => entry.event.type === "mission.trigger.fired"),
    ).toHaveLength(1);
    store.close();
  });

  it("honors skip and run-once-late after downtime and persists trigger state", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-trigger-replay-"));
    const path = join(root, "events.db");
    let now = new Date("2026-07-12T00:00:00.000Z");
    const authenticateOperator = (request: Request) =>
      Promise.resolve(request.headers.has("authorization") ? { operatorId: "operator-test" } : undefined);
    let store = new SqliteEventStore(path);
    let app = await createControlPlane({
      doctrine,
      eventStore: store,
      clock: () => now,
      authenticateOperator,
    });
    for (const [id, misfirePolicy] of [
      ["skip-once", "skip"],
      ["late-once", "run_once_late"],
    ] as const) {
      expect(
        (
          await app.request("/v1/mission-triggers", {
            method: "POST",
            headers: { authorization: "Bearer operator", "content-type": "application/json" },
            body: JSON.stringify({
              id,
              goal: id,
              schedule: { kind: "once", at: "2026-07-12T01:00:00.000Z" },
              misfirePolicy,
            }),
          })
        ).status,
      ).toBe(201);
    }
    store.close();
    now = new Date("2026-07-12T03:00:00.000Z");
    store = new SqliteEventStore(path);
    app = await createControlPlane({ doctrine, eventStore: store, clock: () => now, authenticateOperator });
    const evaluated = await app.request("/v1/mission-triggers/evaluate", {
      method: "POST",
      headers: { authorization: "Bearer operator" },
    });
    await expect(evaluated.json()).resolves.toEqual({ fired: ["late-once"], skipped: ["skip-once"] });
    expect((await store.readAll()).map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining(["mission.trigger.fired", "mission.trigger.skipped"]),
    );
    store.close();
  });

  it("fails closed when trigger mutation metadata is unclassified or doctrine denies it", async () => {
    const authenticateOperator = () => Promise.resolve({ operatorId: "operator-test" });
    const unclassified = await createControlPlane({
      doctrine,
      authenticateOperator,
      classifyTriggerAction: () => undefined,
    });
    const body = JSON.stringify({
      id: "denied",
      goal: "Denied",
      schedule: { kind: "cron", expression: "* * * * *" },
      misfirePolicy: "skip",
    });
    const missing = await unclassified.request("/v1/mission-triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toEqual({ error: "trigger_action_unclassified" });

    const deniedDoctrine = compileDoctrine([
      {
        ...doctrine.profile,
        actions: { ...doctrine.profile.actions, "mission.trigger.write": { default: "deny", rules: [] } },
      },
    ]);
    const denied = await createControlPlane({ doctrine: deniedDoctrine, authenticateOperator });
    const response = await denied.request("/v1/mission-triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "trigger_action_deny" });
  });
});
