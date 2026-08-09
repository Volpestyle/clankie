import type { AdoptedWorkerBinding, AgentObservation } from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import type { HerdrAgentSource } from "../src/herdr-provider.ts";
import { CompositeHerdrAgentSource, discoverHerdrSessionEndpoints } from "../src/herdr-session-discovery.ts";

function observation(transportInstanceId: string, terminalId: string): AgentObservation {
  return {
    transport: "herdr",
    transportInstanceId,
    terminalId,
    workspace: { workspaceId: `workspace-${transportInstanceId}`, root: "/repo" },
    label: terminalId,
    reportedStatus: "working",
    adoptable: true,
    harness: "claude",
    agentSessionId: `session-${terminalId}`,
    cwd: "/repo",
  };
}

function source(
  observations: AgentObservation[],
  send = vi.fn<HerdrAgentSource["sendToAgent"]>(() => Promise.resolve("delivered")),
): HerdrAgentSource {
  return {
    listAgents: () => Promise.resolve(observations),
    sendToAgent: send,
  };
}

function binding(transportInstanceId: string, terminalId: string): AdoptedWorkerBinding {
  return {
    transport: "herdr",
    transportInstanceId,
    terminalId,
    harness: "claude",
    agentSessionId: `session-${terminalId}`,
    workspace: { workspaceId: `workspace-${transportInstanceId}`, root: "/repo" },
  };
}

describe("discoverHerdrSessionEndpoints", () => {
  it("finds every running session without inherited Herdr state", async () => {
    const endpoints = await discoverHerdrSessionEndpoints({}, () =>
      Promise.resolve(
        JSON.stringify({
          sessions: [
            { name: "default", running: true, socket_path: "/tmp/herdr-default.sock" },
            { name: "client work", running: true, socket_path: "/tmp/herdr-client.sock" },
            { name: "stopped", running: false, socket_path: "/tmp/herdr-stopped.sock" },
          ],
        }),
      ),
    );

    expect(endpoints).toEqual([
      { instanceId: "client-work", socketPath: "/tmp/herdr-client.sock" },
      { instanceId: "default", socketPath: "/tmp/herdr-default.sock" },
    ]);
  });

  it("deduplicates an inherited socket already returned by discovery", async () => {
    const endpoints = await discoverHerdrSessionEndpoints(
      { HERDR_SOCKET_PATH: "/tmp/herdr-default.sock" },
      () =>
        Promise.resolve(
          JSON.stringify({
            sessions: [{ name: "default", running: true, socket_path: "/tmp/herdr-default.sock" }],
          }),
        ),
    );

    expect(endpoints).toEqual([{ instanceId: "default", socketPath: "/tmp/herdr-default.sock" }]);
  });

  it("uses the inherited socket when CLI discovery is unavailable", async () => {
    const endpoints = await discoverHerdrSessionEndpoints({ HERDR_SOCKET_PATH: "/tmp/inherited.sock" }, () =>
      Promise.reject(new Error("herdr is not installed")),
    );

    expect(endpoints).toEqual([{ instanceId: "current", socketPath: "/tmp/inherited.sock" }]);
  });

  it("keeps normalized session-name collisions as distinct transport instances", async () => {
    const endpoints = await discoverHerdrSessionEndpoints({}, () =>
      Promise.resolve(
        JSON.stringify({
          sessions: [
            { name: "client work", running: true, socket_path: "/tmp/herdr-client-a.sock" },
            { name: "client-work", running: true, socket_path: "/tmp/herdr-client-b.sock" },
          ],
        }),
      ),
    );

    expect(endpoints).toHaveLength(2);
    expect(new Set(endpoints.map(({ instanceId }) => instanceId)).size).toBe(2);
    expect(endpoints[0]?.instanceId).toBe("client-work");
    expect(endpoints[1]?.instanceId).toMatch(/^client-work-[a-f0-9]{12}$/u);
  });

  it("can explicitly disable session enumeration while retaining the inherited socket", async () => {
    const run = vi.fn(() => Promise.resolve("not used"));

    const endpoints = await discoverHerdrSessionEndpoints(
      {
        CLANKIE_HERDR_SESSION_DISCOVERY: "disabled",
        HERDR_SOCKET_PATH: "/tmp/inherited.sock",
      },
      run,
    );

    expect(run).not.toHaveBeenCalled();
    expect(endpoints).toEqual([{ instanceId: "current", socketPath: "/tmp/inherited.sock" }]);
  });
});

describe("CompositeHerdrAgentSource", () => {
  it("aggregates observations and preserves identical terminal ids from separate sessions", async () => {
    const composite = new CompositeHerdrAgentSource(
      new Map([
        ["alpha", source([observation("alpha", "term-1")])],
        ["beta", source([observation("beta", "term-1")])],
      ]),
    );

    expect(await composite.listAgents()).toEqual([
      observation("alpha", "term-1"),
      observation("beta", "term-1"),
    ]);
  });

  it("delivers only through the bound transport instance", async () => {
    const alphaSend = vi.fn<HerdrAgentSource["sendToAgent"]>(() => Promise.resolve("delivered"));
    const betaSend = vi.fn<HerdrAgentSource["sendToAgent"]>(() => Promise.resolve("delivered"));
    const composite = new CompositeHerdrAgentSource(
      new Map([
        ["alpha", source([], alphaSend)],
        ["beta", source([], betaSend)],
      ]),
    );

    const betaBinding = binding("beta", "term-1");
    expect(await composite.sendToAgent(betaBinding, "continue")).toBe("delivered");
    expect(alphaSend).not.toHaveBeenCalled();
    expect(betaSend).toHaveBeenCalledWith(betaBinding, "continue");
    expect(await composite.sendToAgent(binding("missing", "term-1"), "continue")).toBe("terminal_gone");
  });
});
