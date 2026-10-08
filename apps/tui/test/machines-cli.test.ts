import { expect, test } from "vitest";
import { formatMachines, runMachinesCommand } from "../src/command/machines.ts";
import { commandHelp, isHeadlessCaptainCommand } from "../src/command/registry.ts";

test("machines human rows distinguish unreachable counts and candidates", () => {
  const result = formatMachines({
    observedAt: "now",
    machines: [
      {
        id: "pc",
        transport: "ssh",
        configured: true,
        state: "unreachable",
        workerCount: null,
        sessions: [{ name: "work", connectionId: "pc", state: "unreachable", workerCount: null }],
      },
      { id: "laptop", transport: "ssh", configured: false, state: "available", workerCount: 0, sessions: [] },
    ],
  });
  expect(result).toContain("pc  unreported  work  unreachable  ?");
  expect(result).toContain("laptop (candidate)");
  expect(result).toContain("Default workspace changes require clankie restart captain");
  expect(isHeadlessCaptainCommand("machines")).toBe(true);
  expect(commandHelp()).toContain("herdr [status|open|create|disable] | use NAME");
  expect(commandHelp()).not.toContain("set --runtime auto|bundled|external");
});

test("machine sessions connect routes the exact connection ID and machine to the existing writer", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  await runMachinesCommand(["sessions", "pc", "--connect", "work", "--id", "pc-work"], {
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    host: "http://localhost",
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init!.body as string) });
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  expect(requests).toEqual([
    {
      url: "http://localhost/v1/runtime-connections",
      body: { id: "pc-work", machine: "pc", session: "work" },
    },
  ]);
});
