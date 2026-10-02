import { expect, it, vi } from "vitest";
import { emptySettings } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

it("changes startup selection only, retaining active Swarm and external connections", async () => {
  let settings = emptySettings();
  settings.swarm.connections = [
    {
      id: "team",
      conversationId: "global-default",
      endpoint: "/tmp/team.sock",
      actor: "lead",
      scope: "scope",
      credential: "swarm:reference",
      enabled: true,
    },
  ];
  const disconnect = vi.fn();
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    settings: {
      load: async () => settings,
      update: async (mutate) => {
        settings = mutate(settings);
        return settings;
      },
    },
    swarm: {
      status: async () => ({ mode: "swarm", conversations: [{ conversationId: "global-default" }] }),
      disconnect,
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer operator" ? { operatorId: "owner" } : undefined,
  });
  const put = (body: unknown, token = "operator") =>
    clankie.app.request("/v1/swarm/config", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    expect((await put({ enabled: false }, "social")).status).toBe(401);
    expect((await put({ enabled: "false" })).status).toBe(400);
    expect((await put({ enabled: false, connections: [] })).status).toBe(400);
    expect(await (await put({ enabled: false })).json()).toEqual({
      enabled: false,
      active: true,
      restartRequired: true,
      restart: "Restart the captain to apply Swarm configuration.",
    });
    expect(settings.swarm.connections).toHaveLength(1);
    expect(settings.swarm.connections[0]?.enabled).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    expect(
      await (
        await clankie.app.request("/v1/swarm", { headers: { authorization: "Bearer operator" } })
      ).json(),
    ).toMatchObject({
      mode: "swarm",
      enabled: false,
      active: true,
      restartRequired: true,
      connections: settings.swarm.connections,
    });
    expect(await (await put({ enabled: true })).json()).toEqual({
      enabled: true,
      active: true,
      restartRequired: false,
    });
  } finally {
    clankie.close();
  }
});

it("reports disabled startup and keeps local APIs available without a Swarm host", async () => {
  const settings = emptySettings();
  settings.swarm.enabled = false;
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    settings: { load: async () => settings },
    authenticateOperator: async () => ({ operatorId: "owner" }),
  });
  try {
    expect((await clankie.app.request("/health")).status).toBe(200);
    expect(await (await clankie.app.request("/v1/swarm")).json()).toEqual({
      mode: "disabled",
      enabled: false,
      active: false,
      restartRequired: false,
      conversations: [],
      connections: [],
    });
    expect(await (await clankie.app.request("/v1/connections")).json()).toMatchObject({
      swarms: { mode: "disabled", enabled: false, active: false, restartRequired: false },
    });
    expect((await clankie.app.request("/v1/swarm/connections", { method: "POST" })).status).toBe(503);
  } finally {
    clankie.close();
  }
});

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
    const remote = { ...input, ssh: "pc", endpoint: String.raw`\\.\pipe\swarm-mcp-owner` };
    expect((await post({ ...remote, ssh: undefined })).status).toBe(400);
    expect((await post({ ...remote, ssh: "-bad" })).status).toBe(400);
    expect((await post({ ...remote, endpoint: "127.0.0.1:4321" })).status).toBe(400);
    expect((await post(remote)).status).toBe(200);
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(connection);
    expect(imported).toEqual([
      { value: remote, cwd: "/tmp" },
      { value: input, cwd: "/tmp" },
    ]);
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
