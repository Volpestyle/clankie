import { expect, it } from "vitest";
import type { FleetMembershipReport } from "@clankie/protocol/projects";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { machineDoctorCommand } from "../../tui/src/command/doctor.ts";

const report: FleetMembershipReport = {
  machine: "kh2",
  observedAt: "2026-10-03T23:00:00.000Z",
  evidence: "host-process",
  nativeTools: "not-verified",
  totalPanes: 1,
  truncated: false,
  panes: [
    {
      pane: "w3:p8",
      harness: "claude",
      harnessSource: "herdr-inventory",
      nativeSession: "observed",
      hire: "none",
      eligibility: "eligible",
      reason: "Host eligibility only; native tools unverified.",
      projectId: "rivals-agent",
    },
  ],
};

it("exposes only owner-authorized host observations and combines the selected machine's doctor cards", async () => {
  const seen: string[] = [];
  const app = await createClankieApp({
    captain: createStubCaptain(),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    inspectFleetMembership: async (id) => {
      seen.push(id);
      if (id !== "kh2") throw new Error("Unregistered fleet");
      return report;
    },
    inspectFleetHarnesses: async () => ({ claude: [{ versionMatches: true }] }),
  });
  const cli = {
    host: "http://localhost",
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
  };
  try {
    expect((await app.app.request("/v1/runtime-connections/kh2/membership")).status).toBe(401);
    expect(seen).toEqual([]);
    const result = await machineDoctorCommand("kh2", cli);
    expect(result).toMatchObject({
      machine: "kh2",
      harnesses: { harnesses: { claude: [{ versionMatches: true }] } },
      membership: report,
    });
    expect(seen).toEqual(["kh2"]);
    const response = await app.app.request("/v1/runtime-connections/not-configured/membership", {
      headers: { authorization: "Bearer owner" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "membership_inspection_unavailable" });
  } finally {
    await app.close();
  }
});

it("discards a report when owner authority is revoked during inspection", async () => {
  let authorized = true;
  const app = await createClankieApp({
    captain: createStubCaptain(),
    authenticateOperator: async () => (authorized ? { operatorId: "owner" } : undefined),
    inspectFleetMembership: async () => {
      authorized = false;
      return report;
    },
  });
  try {
    const response = await app.app.request("/v1/runtime-connections/kh2/membership");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication_required" });
  } finally {
    await app.close();
  }
});

it("retains a usable harness card when host membership inspection is unavailable", async () => {
  const app = await createClankieApp({
    captain: createStubCaptain(),
    authenticateOperator: async () => ({ operatorId: "owner" }),
    inspectFleetHarnesses: async () => ({ claude: [{ enabled: true }] }),
  });
  try {
    const result = await machineDoctorCommand("kh2", {
      host: "http://localhost",
      env: { CLANKIE_OPERATOR_TOKEN: "owner" },
      fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
    });
    expect(result).toMatchObject({
      harnesses: { harnesses: { claude: [{ enabled: true }] } },
      membership: { status: "unavailable" },
    });
  } finally {
    await app.close();
  }
});
