import { expect, it } from "vitest";
import { runAgentsCommand, splitQuotedArguments } from "../src/command/agents.ts";

it("maps agents verbs onto the operator session and host routes", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const options = {
    env: { CLANKIE_OPERATOR_TOKEN: "operator" },
    fetchImpl: (async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer operator");
      const parsed = new URL(String(url));
      calls.push({
        path: `${parsed.pathname}${parsed.search}`,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
      });
      return Response.json({ ok: true });
    }) as typeof fetch,
  };
  await runAgentsCommand([], options);
  await runAgentsCommand(["--host", "pc", "--limit", "5"], options);
  await runAgentsCommand(["read", "pc:01a0", "--tail", "10"], options);
  await runAgentsCommand(["read", "pc:01a0", "--after", "abc"], options);
  await runAgentsCommand(
    ["resume", "pc:01a0", "--conversation", "selected-conversation", "--fleet", "pc", "--brief", "carry on"],
    options,
  );
  await runAgentsCommand(
    ["hosts", "add", "pc", "--ssh", "volpe@supedupsilly", "--shell", "powershell"],
    options,
  );
  await runAgentsCommand(["hosts", "remove", "pc"], options);
  expect(calls).toEqual([
    { path: "/v1/agent-sessions", method: "GET" },
    { path: "/v1/agent-sessions?host=pc&limit=5", method: "GET" },
    { path: "/v1/agent-sessions/read?ref=pc%3A01a0&tail=10", method: "GET" },
    { path: "/v1/agent-sessions/read?ref=pc%3A01a0&after=abc", method: "GET" },
    {
      path: "/v1/agent-sessions/resume",
      method: "POST",
      body: { ref: "pc:01a0", conversationId: "selected-conversation", fleet: "pc", brief: "carry on" },
    },
    {
      path: "/v1/agent-hosts",
      method: "POST",
      body: { id: "pc", ssh: "volpe@supedupsilly", shell: "powershell" },
    },
    { path: "/v1/agent-hosts/pc", method: "DELETE" },
  ]);
});

it("refuses malformed arguments before any request", async () => {
  const fetchImpl = (async () => {
    throw new Error("no request expected");
  }) as unknown as typeof fetch;
  for (const args of [
    ["read"],
    ["read", "pc:01a0", "--tail", "1", "--after", "c"],
    ["hosts", "add", "pc"],
    ["list", "--bogus", "1"],
    ["list", "--host"],
    ["resume"],
    ["resume", "pc:01a0", "--fleet"],
    // Resuming a saved session headlessly is retired (ADR 0203).
    ["send", "pc:01a0", "hello"],
    ["runs"],
  ])
    await expect(runAgentsCommand(args, { env: { CLANKIE_OPERATOR_TOKEN: "t" }, fetchImpl })).rejects.toThrow(
      /Usage: clankie agents/,
    );
});

it("surfaces the service's reason for a refused read", async () => {
  const fetchImpl = (async () =>
    Response.json(
      { error: "agent_session_read_failed", detail: "Invalid transcript cursor" },
      { status: 400 },
    )) as unknown as typeof fetch;
  await expect(
    runAgentsCommand(["read", "pc:01a0", "--after", "x"], {
      env: { CLANKIE_OPERATOR_TOKEN: "t" },
      fetchImpl,
    }),
  ).rejects.toThrow("Invalid transcript cursor");
});

it("reads known identities from the fleet API rather than the saved session inventory", async () => {
  const calls: unknown[] = [];
  const result = await runAgentsCommand(["contacts"], {
    env: { CLANKIE_CAPTAIN_TOKEN: "captain" },
    fetchImpl: (async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer captain");
      calls.push(JSON.parse(init!.body as string));
      return Response.json({
        op: "fleet",
        schemaVersion: 1,
        snapshot: {
          schemaVersion: 1,
          cursor: "000000000001",
          seats: [],
          personas: [],
          channels: [],
        },
      });
    }) as typeof fetch,
  });
  expect(result).toEqual([]);
  expect(calls).toEqual([expect.objectContaining({ op: "fleet" })]);
});

it("assigns and clears a persona's role by name or id through set_persona_role", async () => {
  const now = "2026-10-02T00:00:00.000Z";
  const persona = {
    schemaVersion: 1,
    personaId: "agent-1",
    name: "Pixel Smith",
    appearance: { variant: "teal", accessory: "none", shape: "circle" },
    harness: "claude",
    createdAt: now,
    updatedAt: now,
  };
  const twin = { ...persona, personaId: "agent-2", name: "Twin" };
  const calls: Array<Record<string, unknown>> = [];
  const options = {
    env: { CLANKIE_CAPTAIN_TOKEN: "captain" },
    fetchImpl: (async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      calls.push(request);
      if (request.op === "roles")
        return Response.json({
          op: "roles",
          schemaVersion: 1,
          roles: [{ role: "Sound Designer", builtIn: false, count: 1 }],
        });
      if (request.op === "fleet")
        return Response.json({
          op: "fleet",
          schemaVersion: 1,
          snapshot: {
            schemaVersion: 1,
            cursor: "0",
            seats: [],
            personas: [persona, twin, { ...twin, personaId: "agent-3" }],
            channels: [],
          },
        });
      return Response.json({
        op: "set_persona_role",
        schemaVersion: 1,
        persona: request.role === null ? persona : { ...persona, role: request.role },
      });
    }) as typeof fetch,
  };
  expect(await runAgentsCommand(["role", "pixel", "smith", "Designer"], options)).toMatchObject({
    role: "designer",
  });
  expect(calls.at(-1)).toEqual({
    op: "set_persona_role",
    schemaVersion: 1,
    personaId: "agent-1",
    role: "designer",
  });
  await runAgentsCommand(["role", "agent-1", "none"], options);
  expect(calls.at(-1)).toMatchObject({ personaId: "agent-1", role: null });
  await runAgentsCommand(["role", "Pixel Smith", "  Sound   Designer"], options);
  expect(calls.at(-1)).toMatchObject({ personaId: "agent-1", role: "Sound Designer" });
  await expect(runAgentsCommand(["role", "agent-1", "wiz/ard"], options)).rejects.toThrow("Invalid role");
  await expect(runAgentsCommand(["role", "twin", "builder"], options)).rejects.toThrow("persona id");
  await expect(runAgentsCommand(["role", "nobody", "builder"], options)).rejects.toThrow("No agent named");
  await expect(runAgentsCommand(["role", "builder"], options)).rejects.toThrow("Usage");
  expect(await runAgentsCommand(["roles"], options)).toEqual([
    { role: "Sound Designer", builtIn: false, count: 1 },
  ]);
});

it("lists roles in use and splits quoted TUI arguments", async () => {
  expect(splitQuotedArguments(`role "Pixel Smith" 'sound designer'  none`)).toEqual([
    "role",
    "Pixel Smith",
    "sound designer",
    "none",
  ]);
});

it("renames a Unicode agent by id using a name-only persona update", async () => {
  const now = "2026-10-03T00:00:00.000Z";
  const persona = {
    schemaVersion: 1,
    personaId: "agent-1",
    name: "Noor",
    appearance: { variant: "teal", accessory: "none", shape: "circle" },
    harness: "codex",
    createdAt: now,
    updatedAt: now,
  };
  const calls: unknown[] = [];
  const result = await runAgentsCommand(["rename", "agent-1", "美咲"], {
    env: { CLANKIE_CAPTAIN_TOKEN: "captain" },
    fetchImpl: (async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      calls.push(request);
      if (request.op === "fleet")
        return Response.json({
          op: "fleet",
          schemaVersion: 1,
          snapshot: { schemaVersion: 1, cursor: "0", seats: [], personas: [persona], channels: [] },
        });
      return Response.json({
        op: "update_persona",
        schemaVersion: 1,
        persona: { ...persona, name: request.persona.name },
      });
    }) as typeof fetch,
  });
  expect(result).toMatchObject({ personaId: "agent-1", name: "美咲" });
  expect(calls[1]).toEqual({
    op: "update_persona",
    schemaVersion: 1,
    persona: { schemaVersion: 1, personaId: "agent-1", name: "美咲" },
  });
});
