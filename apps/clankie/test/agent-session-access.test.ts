import { expect, test, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { captainTools } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import type { AgentSessions, SavedAgentSession } from "../src/agent-sessions.ts";
import { AgentSessionRequestError } from "@clankie/agent-transcript";

function sessionPort() {
  return {
    hosts: vi.fn(async () => [{ id: "local" as const }]),
    list: vi.fn(async () => ({ sessions: [], errors: [] })),
    read: vi.fn(async () => {
      throw new Error("unused");
    }),
    resolve: vi.fn(async (): Promise<SavedAgentSession> => {
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
      ["/v1/agent-sessions/resume", "POST"],
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
  }
  for (const denied of [names("discord_presence"), names("discord_presence", false)]) {
    expect(denied).not.toContain("agent_sessions");
    expect(denied).not.toContain("agent_session_read");
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
    const body = "x".repeat(4 * 1024 + 1);
    const response = await app.app.request("/v1/agent-hosts", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    expect(response.status).toBe(413);
    expect(authenticate).not.toHaveBeenCalled();
    for (const operation of Object.values(sessions)) expect(operation).not.toHaveBeenCalled();
  } finally {
    app.close();
  }
});

test("transcript routes retain typed refusals and no headless send route", async () => {
  const sessions = sessionPort();
  sessions.read.mockRejectedValue(new AgentSessionRequestError("No session matches abc", 404));
  const app = await createClankieApp({
    captain: createStubCaptain(),
    agentSessions: sessions,
    authenticateOperator: async () => ({ operatorId: "owner" }),
  });
  try {
    const response = await app.app.request("/v1/agent-sessions/read?ref=local:abc");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "agent_session_read_failed",
      detail: "No session matches abc",
    });
    // Continuing a session belongs to its seat (ADR 0203); the headless send route is gone.
    const send = await app.app.request("/v1/agent-sessions/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "local:abc", message: "hello" }),
    });
    expect(send.status).toBe(404);
  } finally {
    app.close();
  }
});

test("native resume uses the existing hire service after fresh transcript resolution", async () => {
  const sessions = sessionPort();
  const ref = "local:10000000-0000-4000-8000-000000000001";
  sessions.resolve.mockResolvedValue({
    ref,
    host: "local",
    sessionId: ref.slice(6),
    workingDirectory: "/work",
    file: { harness: "claude", path: "/history/session.jsonl", size: 1, mtimeMs: 1 },
  });
  const serve = vi.fn(async () => ({
    op: "spawn_seat" as const,
    schemaVersion: 1 as const,
    result: {
      outcome: "failed" as const,
      reason: "delivery_unconfirmed" as const,
      detail: "inspect existing pane; do not resend",
    },
  }));
  const app = await createClankieApp({
    captain: createStubCaptain({ serveOperatorConversation: serve }),
    agentSessions: sessions,
    authenticateOperator: async () => ({ operatorId: "owner" }),
  });
  try {
    const response = await app.app.request("/v1/agent-sessions/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "local:1000", brief: "continue" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "failed", reason: "delivery_unconfirmed" });
    expect(sessions.resolve).toHaveBeenCalledWith("local:1000");
    expect(serve).toHaveBeenCalledOnce();
    expect(serve).toHaveBeenCalledWith({
      schemaVersion: 1,
      op: "spawn_seat",
      seat: {
        schemaVersion: 1,
        harness: "claude",
        resume: ref,
        title: "Resume claude",
        workingDirectory: "/work",
      },
      brief: "continue",
    });
    for (const body of [
      { ref, brief: "\0" },
      { ref, brief: "🙂".repeat(9000) },
      { ref, message: "legacy runner" },
    ]) {
      expect(
        (
          await app.app.request("/v1/agent-sessions/resume", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(serve).toHaveBeenCalledOnce();
  } finally {
    app.close();
  }
});
