import { expect, test, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { captainTools } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import type { AgentSessions } from "../src/agent-sessions.ts";
import { AgentSessionRequestError } from "@clankie/agent-transcript";

function sessionPort() {
  return {
    hosts: vi.fn(async () => [{ id: "local" as const }]),
    list: vi.fn(async () => ({ sessions: [], errors: [] })),
    read: vi.fn(async () => {
      throw new Error("unused");
    }),
    send: vi.fn(async () => {
      throw new Error("unused");
    }),
    runs: vi.fn(() => []),
    run: vi.fn(() => {
      throw new Error("unused");
    }),
    release: vi.fn(() => {
      throw new Error("unused");
    }),
    cancel: vi.fn(() => {
      throw new Error("unused");
    }),
    addHost: vi.fn(async () => []),
    removeHost: vi.fn(async () => []),
  } satisfies AgentSessions;
}

test("transcript API never reaches host operations without operator authentication", async () => {
  const sessions = sessionPort();
  const app = await createClankieApp({
    captain: createStubCaptain(),
    agentSessions: sessions,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  try {
    for (const [path, method] of [
      ["/v1/agent-hosts", "GET"],
      ["/v1/agent-hosts", "POST"],
      ["/v1/agent-hosts/pc", "DELETE"],
      ["/v1/agent-sessions", "GET"],
      ["/v1/agent-sessions/read?ref=local:abc", "GET"],
      ["/v1/agent-sessions/send", "POST"],
      ["/v1/agent-sessions/runs", "GET"],
      ["/v1/agent-sessions/runs/test", "GET"],
      ["/v1/agent-sessions/runs/test", "DELETE"],
      ["/v1/agent-sessions/runs/test/release", "POST"],
    ]) {
      expect((await app.app.request(path!, { method: method! })).status).toBe(401);
    }
    for (const operation of Object.values(sessions)) expect(operation).not.toHaveBeenCalled();
    expect(
      (await app.app.request("/v1/agent-sessions", { headers: { authorization: "Bearer owner" } })).status,
    ).toBe(200);
    expect(sessions.list).toHaveBeenCalledOnce();
  } finally {
    app.close();
  }
});

test("transcript tools follow machine authority, independent of Herdr availability", () => {
  const deps = {
    agentSessions: sessionPort(),
    herdrAvailable: () => false,
    embodiment: {},
  } as unknown as CaptainDeps;
  const names = (lane: "operator" | "discord_presence", shell?: boolean) =>
    captainTools(deps, shell === undefined ? {} : { shell }, {} as LaneLog, lane).map((t) => t.name);
  for (const allowed of [names("operator"), names("discord_presence", true)]) {
    expect(allowed).toContain("agent_sessions");
    expect(allowed).toContain("agent_session_read");
    expect(allowed).toContain("agent_session_send");
    expect(allowed).toContain("agent_session_run");
  }
  for (const denied of [names("discord_presence"), names("discord_presence", false)]) {
    expect(denied).not.toContain("agent_sessions");
    expect(denied).not.toContain("agent_session_read");
    expect(denied).not.toContain("agent_session_send");
    expect(denied).not.toContain("agent_session_run");
  }
});

test("transcript routes distinguish unavailable authentication from an unavailable session port", async () => {
  const sessions = sessionPort();
  for (const authentication of [false, true]) {
    const app = await createClankieApp({
      captain: createStubCaptain(),
      ...(authentication
        ? { authenticateOperator: async () => ({ operatorId: "owner" }) }
        : { agentSessions: sessions }),
    });
    try {
      const response = await app.app.request("/v1/agent-hosts");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: authentication ? "agent_sessions_unavailable" : "operator_authentication_unavailable",
      });
    } finally {
      app.close();
    }
  }
  for (const operation of Object.values(sessions)) expect(operation).not.toHaveBeenCalled();
});

test("transcript request limits remain before authentication and never invoke host operations", async () => {
  const sessions = sessionPort();
  const authenticate = vi.fn(async () => ({ operatorId: "owner" }));
  const app = await createClankieApp({
    captain: createStubCaptain(),
    agentSessions: sessions,
    authenticateOperator: authenticate,
  });
  try {
    for (const [path, size] of [
      ["/v1/agent-hosts", 4 * 1024],
      ["/v1/agent-sessions/send", 40 * 1024],
    ] as const) {
      const body = "x".repeat(size + 1);
      const response = await app.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length) },
        body,
      });
      expect(response.status).toBe(413);
    }
    expect(authenticate).not.toHaveBeenCalled();
    for (const operation of Object.values(sessions)) expect(operation).not.toHaveBeenCalled();
  } finally {
    app.close();
  }
});

test("transcript routes retain typed refusals and distinguish unknown runs", async () => {
  const sessions = sessionPort();
  sessions.send.mockRejectedValue(new AgentSessionRequestError("Session already has a run", 409));
  const app = await createClankieApp({
    captain: createStubCaptain(),
    agentSessions: sessions,
    authenticateOperator: async () => ({ operatorId: "owner" }),
  });
  try {
    const response = await app.app.request("/v1/agent-sessions/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "local:abc", message: "hello" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "agent_session_send_refused",
      detail: "Session already has a run",
    });
    const unknown = await app.app.request("/v1/agent-sessions/runs/missing");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown_agent_session_run", detail: "unused" });
  } finally {
    app.close();
  }
});
