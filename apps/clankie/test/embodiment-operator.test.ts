import type { ActivityObservationSnapshot, PlayStillRead, PlayStoryRead } from "@clankie/interactive-environment";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createClankieApp, type TrustedOperatorIdentity } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const OPERATOR = { authorization: "Bearer operator-secret" };
const CAPTAIN = { authorization: "Bearer captain-secret" };

async function makeApp(
  activity?: () => ActivityObservationSnapshot | undefined,
  playSight?: { still(): PlayStillRead; story(): PlayStoryRead },
): Promise<Hono> {
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    authenticateOperator: (request: Request): Promise<TrustedOperatorIdentity | undefined> =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer operator-secret"
          ? { operatorId: "operator-james" }
          : undefined,
      ),
    authenticateCaptain: (request: Request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer captain-secret"
          ? { captainId: "captain-test" }
          : undefined,
      ),
    activityObservations: { current: () => Promise.resolve(activity?.()) },
    ...(playSight === undefined ? {} : { playSight }),
  });
  return app;
}

async function submitStart(app: Hono): Promise<Response> {
  return app.request("/v1/embodiment/intents", {
    method: "POST",
    headers: { ...CAPTAIN, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "start",
      schemaVersion: 1,
      intentId: "intent-live-1",
      originLane: "discord_presence",
      requestedBy: "user-1",
      requestedAt: "2026-07-26T12:00:00.000Z",
      environmentId: "pokemon-firered",
      budget: { maxTurns: 40, maxDurationMs: 30 * 60 * 1_000 },
    }),
  });
}

describe("operator play controls", () => {
  it("refuses the stop without operator authentication", async () => {
    const app = await makeApp();
    const response = await app.request("/v1/embodiment/sessions/live/stop", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("says nothing is playing rather than minting a stop for a ghost", async () => {
    const app = await makeApp();
    const response = await app.request("/v1/embodiment/sessions/live/stop", {
      method: "POST",
      headers: OPERATOR,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_playing" });
  });

  it("stops the live session under the operator lane, attributed to the operator", async () => {
    const app = await makeApp();
    expect((await submitStart(app)).status).toBe(200);

    const response = await app.request("/v1/embodiment/sessions/live/stop", {
      method: "POST",
      headers: OPERATOR,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcome: string; session?: { sessionId: string } };
    expect(body.outcome).toBe("stop_requested");
  });

  it("lets the operator read the live session, and never an unauthenticated caller", async () => {
    const app = await makeApp();
    await submitStart(app);

    const denied = await app.request("/v1/embodiment/sessions/live");
    expect(denied.status).toBe(401);

    const response = await app.request("/v1/embodiment/sessions/live", { headers: OPERATOR });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: { environmentId: string } | null };
    expect(body.session?.environmentId).toBe("pokemon-firered");
  });

  it("projects the runner's matching latest activity to captain and operator without persistence", async () => {
    let activity: ActivityObservationSnapshot | undefined;
    const app = await makeApp(() => activity);
    const started = await submitStart(app);
    const startedBody = (await started.json()) as { session: { sessionId: string } };
    activity = {
      schemaVersion: 1,
      surface: "gba_emulator",
      sessionId: startedBody.session.sessionId,
      environmentId: "pokemon-firered",
      sequence: 18,
      observedAt: "2026-08-03T02:09:16.868Z",
      selfAuthored: {
        objective: "leave Oak's lab",
        intent: "dismiss the dialog",
        commentary: "The continuation marker is visible.",
      },
      runnerObserved: {
        outcome: "accepted",
        effect: "battle state changed",
        progress: {
          distinctTiles: 12,
          maps: ["oaks-lab"],
          turnsSinceNewTile: 3,
          actionsPerNewTile: 1.8,
        },
        framebufferSha256: null,
      },
    };

    const operatorRead = await app.request("/v1/embodiment/sessions/live/activity", { headers: OPERATOR });
    expect(operatorRead.status).toBe(200);
    expect(await operatorRead.json()).toMatchObject({
      outcome: "snapshot",
      snapshot: {
        sessionId: startedBody.session.sessionId,
        selfAuthored: { objective: "leave Oak's lab" },
        runnerObserved: { effect: "battle state changed" },
      },
    });
    const captainRead = await app.request("/v1/embodiment/sessions/live/activity", { headers: CAPTAIN });
    expect(captainRead.status).toBe(200);
  });

  it("returns pending before the first turn and rejects unauthenticated reads", async () => {
    const app = await makeApp(() => undefined);
    await submitStart(app);
    expect((await app.request("/v1/embodiment/sessions/live/activity")).status).toBe(401);
    const response = await app.request("/v1/embodiment/sessions/live/activity", { headers: OPERATOR });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "pending", environmentId: "pokemon-firered" });
  });

  it("fails closed when the runner snapshot belongs to another activity session", async () => {
    const app = await makeApp(() => ({
      schemaVersion: 1,
      surface: "gba_emulator",
      sessionId: "stale-session",
      environmentId: "pokemon-firered",
      sequence: 1,
      observedAt: "2026-08-03T02:09:16.868Z",
      selfAuthored: { objective: null, intent: null, commentary: null },
      runnerObserved: {
        outcome: "accepted",
        effect: null,
        progress: { distinctTiles: 0, maps: [], turnsSinceNewTile: 0, actionsPerNewTile: null },
        framebufferSha256: null,
      },
    }));
    await submitStart(app);
    const response = await app.request("/v1/embodiment/sessions/live/activity", { headers: OPERATOR });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "activity_observation_identity_mismatch" });
  });

  it("lets captain and operator pull a live still and a journal story", async () => {
    let sessionId = "";
    const sight = {
      still: (): PlayStillRead => ({
        schemaVersion: 1,
        outcome: "still",
        sessionId,
        environmentId: "pokemon-firered",
        mimeType: "image/png",
        width: 240,
        height: 160,
        sha256: "a".repeat(64),
        capturedAt: "2026-08-15T20:00:00.000Z",
        pngBase64: "aa==",
      }),
      story: (): PlayStoryRead => ({
        schemaVersion: 1,
        outcome: "card",
        card: {
          schemaVersion: 1,
          sessionId,
          environmentId: "pokemon-firered",
          scenarioId: "firered-bedroom-route",
          startedAt: "2026-08-15T20:00:00.000Z",
          turnsTaken: 3,
          objective: "leave the lab",
          maps: ["oaks-lab"],
          moments: [{ at: "2026-08-15T20:00:01.000Z", effect: "bumped Oak", toward: "leave the lab" }],
        },
      }),
    };
    const app = await makeApp(undefined, sight);
    const started = await submitStart(app);
    sessionId = ((await started.json()) as { session: { sessionId: string } }).session.sessionId;

    expect((await app.request("/v1/embodiment/sessions/live/still")).status).toBe(401);
    const still = await app.request("/v1/embodiment/sessions/live/still", { headers: OPERATOR });
    expect(still.status).toBe(200);
    expect(await still.json()).toMatchObject({ outcome: "still", sessionId, pngBase64: "aa==" });
    const story = await app.request("/v1/embodiment/sessions/live/story", { headers: CAPTAIN });
    expect(story.status).toBe(200);
    expect(await story.json()).toMatchObject({
      outcome: "card",
      card: { sessionId, objective: "leave the lab", moments: [{ effect: "bumped Oak" }] },
    });
  });
});
