import { CAPTAIN_TURN_METRICS_PATH, type CaptainTurnSettledMetrics } from "@clankie/protocol";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createClankieApp, type TrustedOperatorIdentity } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const OPERATOR = { authorization: "Bearer operator-secret" };

function row(runId: string, overrides: Partial<CaptainTurnSettledMetrics> = {}): CaptainTurnSettledMetrics {
  return {
    schemaVersion: 1,
    type: "captain.turn.settled",
    conversationId: "conv-1",
    lane: "operator",
    runId,
    acceptedAt: "2026-09-04T12:00:00.000Z",
    completedAt: "2026-09-04T12:00:05.000Z",
    outcome: "completed",
    toolCount: { bash: 2 },
    mutatingCount: 0,
    execution: { model: "gpt-6-astra", provider: "openai-codex", effort: "high" },
    usage: { totalTokens: 4_200, reports: 2 },
    ...overrides,
  };
}

async function makeApp(
  readTurnMetrics: (query: {
    limit?: number;
    runId?: string;
  }) => readonly CaptainTurnSettledMetrics[] = () => [],
): Promise<Hono> {
  const { app } = await createClankieApp({
    captain: createStubCaptain({ readTurnMetrics: async (query) => readTurnMetrics(query) }),
    authenticateOperator: (request: Request): Promise<TrustedOperatorIdentity | undefined> =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer operator-secret"
          ? { operatorId: "operator-james" }
          : undefined,
      ),
  });
  return app;
}

describe("captain turn metrics route", () => {
  it("refuses an unauthenticated read", async () => {
    const app = await makeApp(() => [row("run-1")]);
    const response = await app.request(CAPTAIN_TURN_METRICS_PATH);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("run-1");
  });

  it("refuses a wrong bearer", async () => {
    const app = await makeApp(() => [row("run-1")]);
    const response = await app.request(CAPTAIN_TURN_METRICS_PATH, {
      headers: { authorization: "Bearer not-the-operator" },
    });
    expect(response.status).toBe(401);
  });

  it("answers bounded items with explicit unknowns and no transcript", async () => {
    const app = await makeApp(() => [
      row("run-2"),
      row("run-1", { execution: null, usage: null, contextTokensEnd: 3_000 }),
    ]);
    const response = await app.request(CAPTAIN_TURN_METRICS_PATH, { headers: OPERATOR });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { schemaVersion: number; items: CaptainTurnSettledMetrics[] };
    expect(body.schemaVersion).toBe(1);
    expect(body.items.map((item) => item.runId)).toEqual(["run-2", "run-1"]);
    expect(body.items[0]?.execution).toEqual({
      model: "gpt-6-astra",
      provider: "openai-codex",
      effort: "high",
    });
    expect(body.items[0]?.usage).toEqual({ totalTokens: 4_200, reports: 2 });
    // A legacy row says unknown out loud, and context tokens never become usage.
    expect(body.items[1]?.execution).toBeNull();
    expect(body.items[1]?.usage).toBeNull();
    expect(body.items[1]?.contextTokensEnd).toBe(3_000);
    for (const item of body.items) {
      expect(Object.keys(item)).not.toContain("args");
      expect(Object.keys(item)).not.toContain("text");
    }
  });

  it("passes runId and limit through, and ignores a limit it cannot read", async () => {
    const seen: { limit?: number; runId?: string }[] = [];
    const app = await makeApp((query) => {
      seen.push(query);
      return [];
    });
    await app.request(`${CAPTAIN_TURN_METRICS_PATH}?runId=run-7&limit=5`, { headers: OPERATOR });
    await app.request(`${CAPTAIN_TURN_METRICS_PATH}?limit=abc&runId=`, { headers: OPERATOR });
    await app.request(CAPTAIN_TURN_METRICS_PATH, { headers: OPERATOR });
    expect(seen).toEqual([{ runId: "run-7", limit: 5 }, {}, {}]);
  });
});
