import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import type { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedOperatorIdentity } from "../src/app.ts";

const tempDirs: string[] = [];
let doctrine: Awaited<ReturnType<typeof loadDoctrine>>;
const OPERATOR = { authorization: "Bearer operator-secret" };
const CAPTAIN = { authorization: "Bearer captain-secret" };

async function loadDoctrine() {
  return compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
}

beforeAll(async () => {
  doctrine = await loadDoctrine();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeApp(): Promise<Hono> {
  const root = await mkdtemp(join(tmpdir(), "clankie-embodiment-operator-"));
  tempDirs.push(root);
  return await createControlPlane({
    doctrine,
    eventStore: new SqliteEventStore(join(root, "events.db")),
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
  });
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
});
