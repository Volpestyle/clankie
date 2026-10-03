import { expect, it } from "vitest";
import { HERDR_SOCKET_HEADER } from "@clankie/protocol";
import { parseWorkOnArgs, runWorkOnCommand } from "../src/command/work-on.ts";

it("requires a complete issue identity and never accepts a caller-chosen seat", () => {
  expect(parseWorkOnArgs(["Fix loading", "--repo", "workspace", "--issue", "VUH-1436"], "w1:p2")).toEqual({
    herdrPaneId: "w1:p2",
    assignment: { objective: "Fix loading", issue: { repoId: "workspace", itemId: "VUH-1436" } },
  });
  expect(parseWorkOnArgs(["clear"], "w1:p2").assignment).toBeNull();
  expect(() => parseWorkOnArgs(["Fix", "--issue", "#42"], "w1:p2")).toThrow(/together/u);
  expect(() => parseWorkOnArgs(["Fix", "--seat", "another"], "w1:p2")).toThrow(/Usage/u);
});

it("qualifies the caller's pane with its actual Herdr source session", async () => {
  let body: unknown;
  const code = await runWorkOnCommand(["Fix loading"], {
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_SOCKET_PATH: "/tmp/chosen.sock",
      CLANKIE_CAPTAIN_TOKEN: "captain-test-token",
    },
    stdout: { write: () => undefined },
    fetchImpl: (async (_url, init) => {
      expect(new Headers(init?.headers).get(HERDR_SOCKET_HEADER)).toBe("/tmp/chosen.sock");
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: { outcome: "stated" } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  expect(code).toBe(0);
  expect(body).toEqual({
    op: "state_work",
    schemaVersion: 1,
    work: { herdrPaneId: "w1:p2", assignment: { objective: "Fix loading" } },
  });
  await expect(runWorkOnCommand(["Fix loading"], { env: {} })).rejects.toThrow(/HERDR_PANE_ID/u);
});
