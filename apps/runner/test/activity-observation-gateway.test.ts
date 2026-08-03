import { afterEach, describe, expect, it } from "vitest";
import {
  createActivityObservationGateway,
  type ActivityObservationGateway,
} from "../src/activity-observation-gateway.ts";
import { ActivityObservationProjection } from "../src/activity-observation.ts";

const gateways: ActivityObservationGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe("activity observation gateway", () => {
  it("is exact-loopback, bearer-gated, latest-only, and no-store", async () => {
    const projection = new ActivityObservationProjection();
    projection.publish({
      schemaVersion: 1,
      surface: "gba_emulator",
      sessionId: "play-1",
      environmentId: "pokemon-firered",
      sequence: 7,
      observedAt: "2026-08-03T02:09:16.868Z",
      selfAuthored: { objective: "leave the lab", intent: null, commentary: null },
      runnerObserved: {
        outcome: "accepted",
        effect: "dialog closed",
        progress: { distinctTiles: 3, maps: ["oaks-lab"], turnsSinceNewTile: 1, actionsPerNewTile: 2 },
        framebufferSha256: null,
      },
    });
    const gateway = await createActivityObservationGateway({ projection, token: "secret", port: 0 });
    gateways.push(gateway);
    const url = `http://${gateway.address.host}:${String(gateway.address.port)}/v1/activity-observations/current`;

    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ snapshot: { sessionId: "play-1", sequence: 7 } });
  });

  it("returns not found instead of a stale or fabricated snapshot", async () => {
    const gateway = await createActivityObservationGateway({
      projection: new ActivityObservationProjection(),
      token: "secret",
      port: 0,
    });
    gateways.push(gateway);
    const response = await fetch(
      `http://${gateway.address.host}:${String(gateway.address.port)}/v1/activity-observations/current`,
      { headers: { authorization: "Bearer secret" } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "activity_observation_not_found" });
  });
});
