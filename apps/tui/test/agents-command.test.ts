import { expect, it } from "vitest";
import { runAgentsCommand } from "../src/command/agents.ts";

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
