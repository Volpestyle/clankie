import { expect, it, vi } from "vitest";
import { FLEET_PROJECT_MEMBERSHIP_PATH } from "@clankie/protocol/projects";
import { createFleetProjectMembershipRoutes } from "../src/fleet-project-membership-routes.ts";
import { FleetMembershipReadError, type MembershipAuthorization } from "../src/fleet-project-membership.ts";
const request = { schemaVersion: 1, seats: [{ seatId: "seat", occupantId: "session-hash" }] };
const result = {
  schemaVersion: 1 as const,
  projectsRevision: "a".repeat(64),
  observedAt: new Date().toISOString(),
  seats: [
    {
      ...request.seats[0]!,
      membership: { outcome: "unknown" as const, reason: "no_confirmed_hire" as const },
    },
  ],
};
it("serves an independently authorized no-store optional read", async () => {
  const read = vi.fn(async () => result);
  const auth = vi.fn(async () => true as const);
  const app = createFleetProjectMembershipRoutes({ read }, auth);
  const response = await app.request(FLEET_PROJECT_MEMBERSHIP_PATH, {
    method: "POST",
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  expect(read).toHaveBeenCalledTimes(1);
});
it.each(["authentication_required", "forbidden"] as const)(
  "refuses %s before native reads",
  async (reason) => {
    const read = vi.fn();
    const app = createFleetProjectMembershipRoutes({ read }, async () => reason);
    const response = await app.request(FLEET_PROJECT_MEMBERSHIP_PATH, {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(reason === "forbidden" ? 403 : 401);
    expect(read).not.toHaveBeenCalled();
  },
);
it.each(["injected-proof", "injected-project", "too-many", "duplicate", "oversized"])(
  "rejects %s input without a read",
  async (kind) => {
    const read = vi.fn();
    const app = createFleetProjectMembershipRoutes({ read }, async () => true);
    const body =
      kind === "injected-proof"
        ? { ...request, proof: { pid: 1 } }
        : kind === "injected-project"
          ? { ...request, projectId: "repo" }
          : kind === "too-many"
            ? {
                ...request,
                seats: Array.from({ length: 9 }, (_, i) => ({ seatId: String(i), occupantId: "x" })),
              }
            : kind === "duplicate"
              ? { ...request, seats: [...request.seats, ...request.seats] }
              : { extra: "a".repeat(9000) };
    const response = await app.request(FLEET_PROJECT_MEMBERSHIP_PATH, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(read).not.toHaveBeenCalled();
  },
);
it.each(["changed", "busy", "forbidden", "authentication_required", "unavailable"] as const)(
  "bounds %s error and never exposes process/path text",
  async (code) => {
    const app = createFleetProjectMembershipRoutes(
      {
        read: async () => {
          throw new FleetMembershipReadError(code);
        },
      },
      async () => true,
    );
    const response = await app.request(FLEET_PROJECT_MEMBERSHIP_PATH, {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(
      code === "changed" ? 409 : code === "forbidden" ? 403 : code === "authentication_required" ? 401 : 503,
    );
    expect(await response.json()).toEqual({ error: `membership_${code}` });
  },
);
it("passes the real request abort and a fresh authorizer into the service", async () => {
  let authority: MembershipAuthorization = true;
  const app = createFleetProjectMembershipRoutes(
    {
      read: async (_value, signal, authorize) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        authority = "forbidden";
        const auth = await authorize();
        if (auth !== true) throw new FleetMembershipReadError(auth);
        return result;
      },
    },
    async () => authority,
  );
  expect(
    (await app.request(FLEET_PROJECT_MEMBERSHIP_PATH, { method: "POST", body: JSON.stringify(request) }))
      .status,
  ).toBe(403);
});
it("redacts unexpected native failure details", async () => {
  const app = createFleetProjectMembershipRoutes(
    {
      read: async () => {
        throw new Error("/private/socket pid=999 bearer=secret");
      },
    },
    async () => true,
  );
  const response = await app.request(FLEET_PROJECT_MEMBERSHIP_PATH, {
    method: "POST",
    body: JSON.stringify(request),
  });
  expect(await response.json()).toEqual({ error: "membership_unavailable" });
});
