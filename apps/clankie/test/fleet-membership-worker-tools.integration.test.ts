import { serve } from "@hono/node-server";
import { WorkerBridgeStatusSchema, type WorkerBridgeStatus } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { expect, it } from "vitest";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { inspectFleetMembership } from "../src/fleet-membership-doctor.ts";
import { machineDoctorCommand } from "../../tui/src/command/doctor.ts";

it("projects cached bridge observations across the owner HTTP boundary without changing host eligibility or admitting tools", async () => {
  const observations = new Map<string, WorkerBridgeStatus>([
    [
      "missing",
      WorkerBridgeStatusSchema.parse({
        status: "missing",
        reason: "Authenticated catalog omitted clankie_call.",
        observedAt: "2026-10-05T15:00:00.000Z",
        tools: ["clankie_tools"],
      }),
    ],
    [
      "stalled",
      WorkerBridgeStatusSchema.parse({
        status: "stalled",
        reason: "Catalog request exceeded its observation deadline.",
        pendingSince: "2026-10-05T15:00:00.000Z",
      }),
    ],
    [
      "unknown",
      WorkerBridgeStatusSchema.parse({
        status: "not-observed",
        reason: "No authenticated bridge observation.",
      }),
    ],
  ]);
  const seen: string[] = [];
  let includeObservations = true;
  const service = await createClankieApp({
    captain: createStubCaptain(),
    authenticateOperator: createBearerAuthenticator("fixture-owner", { operatorId: "owner" }),
    inspectFleetHarnesses: async () => ({ codex: { registered: true, versionMatches: true } }),
    inspectFleetMembership: async (machine) =>
      inspectFleetMembership({
        machine,
        connected: async () => machine === "pc",
        panes: async () => [...observations.keys()].map((pane) => ({ pane, harness: "codex" })),
        supportedHarnesses: [],
        observe: async () => {
          throw new Error("Unsupported host inspection must never run");
        },
        hire: async () => ({ state: "none" }),
        settings: async () => ProjectsSettingsSchema.parse({}),
        ...(includeObservations
          ? {
              bridgeStatus(fleet: string, pane: string) {
                seen.push(`${fleet}/${pane}`);
                return observations.get(pane)!;
              },
            }
          : {}),
      }),
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing membership fixture address");
  const host = `http://127.0.0.1:${address.port}`;
  try {
    expect((await fetch(`${host}/v1/runtime-connections/pc/membership`)).status).toBe(401);
    expect(seen).toEqual([]);
    const doctor = await machineDoctorCommand("pc", {
      host,
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
    });
    expect(doctor).toMatchObject({
      harnesses: { codex: { registered: true, versionMatches: true } },
      membership: {
        evidence: "host-process",
        nativeTools: "not-verified",
        panes: [
          { pane: "missing", eligibility: "unsupported", workerTools: observations.get("missing") },
          { pane: "stalled", eligibility: "unsupported", workerTools: observations.get("stalled") },
          { pane: "unknown", eligibility: "unsupported", workerTools: observations.get("unknown") },
        ],
      },
    });
    expect(seen).toEqual(["pc/missing", "pc/stalled", "pc/unknown"]);
    const encoded = JSON.stringify(doctor);
    expect(encoded).not.toContain("Bearer");
    expect(encoded).not.toContain("fixture-owner");
    includeObservations = false;
    const noObservation = await machineDoctorCommand("pc", {
      host,
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
    });
    expect(JSON.stringify(noObservation.membership)).not.toContain("workerTools");
    expect(noObservation.membership).toMatchObject({
      nativeTools: "not-verified",
      panes: [{ eligibility: "unsupported" }, { eligibility: "unsupported" }, { eligibility: "unsupported" }],
    });
  } finally {
    await service.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
  }
});
