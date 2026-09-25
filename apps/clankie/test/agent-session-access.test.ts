import { expect, test, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { captainTools } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import type { AgentSessions } from "../src/agent-sessions.ts";

function sessionPort() {
  return {
    hosts: vi.fn(async () => [{ id: "local" as const }]),
    list: vi.fn(async () => ({ sessions: [], errors: [] })),
    read: vi.fn(async () => {
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
