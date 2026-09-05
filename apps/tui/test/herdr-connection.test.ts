import { expect, it } from "vitest";
import { HERDR_SOCKET_HEADER } from "@clankie/protocol";
import { herdrConnection, readHerdrBinding } from "../src/session/herdr-connection.ts";
import { jumpToHerdrAgent, sourceHerdrSocket } from "../src/session/herdr-report.ts";
import { ensureHerdLeadCompanion } from "../src/observation/herd-lead-companion.ts";
import { createCaptainRouteClient } from "../src/session/operator-conversations.ts";

it("routes viewer, board, and jump commands to the authenticated service's binding", async () => {
  const binding = { runtime: "bundled", session: "default", socketPath: "/tmp/chosen/herdr.sock" } as const;
  const options = {
    repoRoot: "/checkout",
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/other.sock",
      HERD_LEAD_TARGET: "w1:p1",
      CLANKIE_OPERATOR_TOKEN: "owner",
      PATH: "/usr/bin",
    },
    fetchImpl: (async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner");
      return Response.json(binding);
    }) as typeof fetch,
  };
  const connection = herdrConnection(await readHerdrBinding(options), options);
  expect(connection.command).toBe("/checkout/.data/herdr/bin/herdr");
  expect(connection.env.HERDR_SOCKET_PATH).toBe(binding.socketPath);
  expect(connection.env.HERDR_PANE_ID).toBeUndefined();
  expect(connection.env.HERD_LEAD_TARGET).toBeUndefined();
  expect(connection.env.XDG_CONFIG_HOME).toBe("/tmp/chosen");
  const calls: string[][] = [];
  const runCommand = async (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
    expect(env.HERDR_SOCKET_PATH).toBe(binding.socketPath);
    expect(env.HERDR_PANE_ID).toBeUndefined();
    calls.push([command, ...args]);
    return { stdout: "w1:p2", stderr: "" };
  };
  expect((await jumpToHerdrAgent("w1:p2", { env: connection.env, runCommand })).outcome).toBe("ok");
  expect((await ensureHerdLeadCompanion({ env: connection.env, runCommand })).outcome).toBe("ok");
  expect(calls).toEqual([
    ["herdr", "agent", "focus", "w1:p2"],
    ["herdr-lead", "split"],
  ]);
  await expect(readHerdrBinding({ ...options, host: "https://hosted.example" })).rejects.toThrow(
    "local Clankie",
  );
  expect(
    herdrConnection(
      { ...binding, runtime: "external" },
      { ...options, env: { ...options.env, HERDR_SOCKET_PATH: binding.socketPath } },
    ).env.HERDR_PANE_ID,
  ).toBe("w1:p1");
});

it("qualifies caller pane IDs with the caller's session, even when Herdr supplies only a session name", async () => {
  const socket = await sourceHerdrSocket({
    env: { HERDR_ENV: "1", HERDR_SESSION: "work" },
    runCommand: async (_command, args) => {
      expect(args).toEqual(["session", "list", "--json"]);
      return {
        stdout: JSON.stringify({ sessions: [{ name: "work", socket_path: "/tmp/work.sock" }] }),
        stderr: "",
      };
    },
  });
  expect(socket).toBe("/tmp/work.sock");
  await createCaptainRouteClient({
    host: "http://127.0.0.1:4310",
    herdrSocketPath: socket!,
    fetchImpl: (async (_url, init) => {
      expect(new Headers(init?.headers).get(HERDR_SOCKET_HEADER)).toBe(socket);
      return Response.json({});
    }) as typeof fetch,
  }).fetch("/test");
});
