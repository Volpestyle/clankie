import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

it("imports coordinator capabilities only for an operator and an existing conversation", async () => {
  const imported: unknown[] = [],
    disconnected: string[] = [];
  const input = {
    id: "team",
    conversationId: "global-default",
    endpoint: "/tmp/team.sock",
    capability: "s".repeat(64),
  };
  const connection = {
    id: "team",
    conversationId: "global-default",
    endpoint: input.endpoint,
    actor: "lead",
    scope: "scope",
    credential: "swarm:private-reference",
    enabled: true,
  };
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      seatContext: (id) => (id === "global-default" ? { conversationId: id, cwd: "/tmp" } : undefined),
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer operator" ? { operatorId: "owner" } : undefined,
    swarm: {
      status: async () => ({ connections: [connection] }),
      connect: async (value, cwd) => {
        imported.push({ value, cwd });
        return connection;
      },
      disconnect: async (id) => {
        disconnected.push(id);
      },
    },
  });
  const post = (body: unknown, token = "operator") =>
    clankie.app.request("/v1/swarm/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    expect((await post(input, "social")).status).toBe(401);
    expect((await post({ ...input, conversationId: "unknown" })).status).toBe(404);
    expect((await post({ ...input, endpoint: "https://arbitrary.example" })).status).toBe(400);
    expect((await post({ ...input, id: "embedded" })).status).toBe(400);
    expect((await post({ ...input, capability: "x".repeat(20_000) })).status).toBe(413);
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(connection);
    expect(imported).toEqual([{ value: input, cwd: "/tmp" }]);
    expect((await clankie.app.request("/v1/swarm/connections/team", { method: "DELETE" })).status).toBe(401);
    expect(
      (
        await clankie.app.request("/v1/swarm/connections/team", {
          method: "DELETE",
          headers: { authorization: "Bearer operator" },
        })
      ).status,
    ).toBe(200);
    expect(disconnected).toEqual(["team"]);
  } finally {
    clankie.close();
  }
});
