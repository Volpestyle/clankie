import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSwarmCommand } from "../src/command/swarm.ts";

it("imports a private connection file without printing its capability", async () => {
  const root = await mkdtemp("/tmp/clankie-swarm-cli-");
  const file = join(root, "connection.json");
  const capability = "synthetic-session-capability";
  const calls: Array<{ path: string; method: string }> = [];
  const options = {
    env: { CLANKIE_OPERATOR_TOKEN: "operator" },
    fetchImpl: (async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer operator");
      calls.push({ path: String(url), method: init?.method ?? "GET" });
      if (init?.method === "POST") expect(JSON.parse(init.body as string).capability).toBe(capability);
      return Response.json({ id: "team", enabled: init?.method !== "DELETE" });
    }) as typeof fetch,
  };
  try {
    await writeFile(file, JSON.stringify({ id: "team", capability }), { mode: 0o600 });
    expect(JSON.stringify(await runSwarmCommand(["connect", file], options))).not.toContain(capability);
    await runSwarmCommand(["disconnect", "team"], options);
    await runSwarmCommand(["connections"], options);
    expect(calls.map((call) => [new URL(call.path).pathname, call.method])).toEqual([
      ["/v1/swarm/connections", "POST"],
      ["/v1/swarm/connections/team", "DELETE"],
      ["/v1/swarm", "GET"],
    ]);
    await writeFile(join(root, "public.json"), "{}", { mode: 0o644 });
    await expect(runSwarmCommand(["connect", join(root, "public.json")], options)).rejects.toThrow("private");
    await expect(runSwarmCommand(["connect", root], options)).rejects.toThrow("regular");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("lists and messages Swarm personas through the authenticated conversation API", async () => {
  const { defaultOperatorAgentAppearance } = await import("@clankie/protocol");
  const now = "2026-09-24T00:00:00.000Z";
  const persona = {
    schemaVersion: 1,
    personaId: "swarm-peer",
    name: "Peer",
    harness: "swarm",
    appearance: defaultOperatorAgentAppearance("swarm", "swarm-peer"),
    createdAt: now,
    updatedAt: now,
    swarm: {
      conversationId: "global-default",
      connectionId: "remote",
      coordinator: "a".repeat(64),
      scope: "scope",
      actor: "peer",
      generation: 1,
      available: true,
    },
  };
  const conversation = {
    schemaVersion: 1,
    conversationId: "contact-thread",
    title: "Peer",
    scope: { kind: "persona", personaId: "swarm-peer" },
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    sessionState: "unbound",
  };
  const calls: Array<Record<string, unknown>> = [];
  const options = {
    env: { CLANKIE_CAPTAIN_TOKEN: "captain" },
    fetchImpl: (async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer captain");
      const request = JSON.parse(init!.body as string);
      calls.push(request);
      if (request.op === "fleet")
        return Response.json({
          op: "fleet",
          schemaVersion: 1,
          snapshot: { schemaVersion: 1, cursor: "0", seats: [], personas: [persona], channels: [] },
        });
      if (request.op === "create") return Response.json({ op: "create", schemaVersion: 1, conversation });
      return Response.json({
        op: "send",
        schemaVersion: 1,
        result: {
          schemaVersion: 1,
          status: "accepted",
          conversationId: "contact-thread",
          runId: "run-test",
          revision: 1,
          safeCursor: "0",
        },
      });
    }) as typeof fetch,
  };
  expect(await runSwarmCommand(["contacts"], options)).toEqual([persona]);
  expect(await runSwarmCommand(["message", "swarm-peer", "Review", "this"], options)).toMatchObject({
    status: "accepted",
  });
  expect(calls.at(-1)?.turn).toMatchObject({
    conversationId: "contact-thread",
    message: "Review this",
    expectedRevision: 0,
  });
  await expect(runSwarmCommand(["message", "unknown", "hello"], options)).rejects.toThrow(
    "Unknown Swarm contact",
  );
});
