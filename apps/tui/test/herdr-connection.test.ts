import { expect, it } from "vitest";
import { HERDR_SOCKET_HEADER } from "@clankie/protocol";
import { herdrConnection, readHerdrBinding, runFleetHerdr } from "../src/session/herdr-connection.ts";
import { forwardsToFleetHerdr } from "../src/command/herdr.ts";
import { clankieStateHome } from "../src/state-home.ts";
import { herdrPaneIdFromEnv, jumpToHerdrAgent, sourceHerdrSocket } from "../src/session/herdr-report.ts";
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

it("claims a seat only when the console sits in the session the service leads (ADR 0164)", () => {
  const binding = { runtime: "bundled" as const, session: "default", socketPath: "/tmp/fleet/herdr.sock" };
  const inFleet = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/tmp/fleet/herdr.sock" };
  const elsewhere = { HERDR_ENV: "1", HERDR_PANE_ID: "w1Z:p6", HERDR_SOCKET_PATH: "/tmp/other/herdr.sock" };
  expect(herdrPaneIdFromEnv(herdrConnection(binding, { env: inFleet, repoRoot: "/repo" }).env)).toBe("w1:p2");
  expect(
    herdrPaneIdFromEnv(herdrConnection(binding, { env: elsewhere, repoRoot: "/repo" }).env),
  ).toBeUndefined();
});

it("resolves the owner's state home inside a fleet pane, where Herdr's own XDG is private (ADR 0164)", () => {
  const inFleetPane = {
    CLANKIE_STATE_HOME: "/Users/j/.local/state",
    XDG_STATE_HOME: "/Users/j/.clankie/herdr",
  };
  expect(clankieStateHome(inFleetPane)).toBe("/Users/j/.local/state");
  expect(clankieStateHome({ XDG_STATE_HOME: "/custom/state" })).toBe("/custom/state");
  expect(clankieStateHome({ HOME: "/Users/j" })).toBe("/Users/j/.local/state");
});

it("keeps Clankie's own herdr verbs local and forwards the rest to the fleet (ADR 0164)", () => {
  for (const local of [
    ["status"],
    ["set", "--runtime", "auto"],
    ["open"],
    ["create"],
    ["use", "default"],
    [],
  ]) {
    expect(forwardsToFleetHerdr(local)).toBe(false);
  }
  for (const forwarded of [
    ["server", "stop"],
    ["pane", "list"],
    ["agent", "list"],
    ["api", "snapshot"],
  ]) {
    expect(forwardsToFleetHerdr(forwarded)).toBe(true);
  }
});

it("routes an ssh connection through the remote allow-list instead of requiring a local socket", async () => {
  const urls: string[] = [];
  await expect(
    runFleetHerdr(["server", "stop"], {
      repoRoot: "/checkout",
      connectionId: "pc",
      env: { CLANKIE_OPERATOR_TOKEN: "owner" },
      fetchImpl: (async (url, init) => {
        urls.push(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner");
        return Response.json({
          connections: [
            { id: "pc", enabled: true, session: "default", ssh: { host: "pc", shell: "powershell" } },
          ],
        });
      }) as typeof fetch,
    }),
  ).rejects.toThrow("not available on a remote fleet");
  expect(urls).toEqual(["http://127.0.0.1:4310/v1/runtime-connections"]);
});

it.each(["bundled", "external"] as const)(
  "opens the exact %s pane, and only focuses when already in that session",
  async (runtime) => {
    const { openAgentHerdr } = await import("../src/session/herdr-connection.ts");
    const terminal = {
      terminalId: "terminal-1",
      label: "worker",
      workspace: { id: "w1", number: 1, label: "work" },
      tab: { id: "w1:t1", number: 1, label: "work" },
      pane: { id: "w1:p2" },
    };
    const binding = { runtime, session: "default", socketPath: "/tmp/exact.sock" };
    for (const inSession of [false, true]) {
      const calls: { args: readonly string[]; interactive: boolean }[] = [];
      await openAgentHerdr(
        { ...terminal, connection: { kind: "local", binding } },
        {
          repoRoot: "/checkout",
          env: {
            CLANKIE_OPERATOR_TOKEN: "owner",
            ...(inSession ? { HERDR_ENV: "1", HERDR_SOCKET_PATH: binding.socketPath } : {}),
          },
          fetchImpl: (async () => Response.json(binding)) as typeof fetch,
        },
        async (_command, args, env, interactive) => {
          expect(env.HERDR_SOCKET_PATH).toBe(binding.socketPath);
          calls.push({ args, interactive });
        },
      );
      expect(calls).toEqual([
        { args: ["agent", "focus", "w1:p2"], interactive: false },
        ...(inSession ? [] : [{ args: ["client"], interactive: true }]),
      ]);
    }
  },
);

it.each(["posix", "powershell"] as const)(
  "keeps a remote %s pane and session qualified, with no local fallback on failure",
  async (shell) => {
    const { openAgentHerdr } = await import("../src/session/herdr-connection.ts");
    const terminal = {
      runtime: { id: "pc", session: "owned" },
      terminalId: "pc/terminal-1",
      label: "worker",
      workspace: { id: "w1", number: 1, label: "work" },
      tab: { id: "w1:t1", number: 1, label: "work" },
      pane: { id: "w1:p2" },
    };
    const options = {
      repoRoot: "/checkout",
      env: { CLANKIE_OPERATOR_TOKEN: "owner" },
      fetchImpl: (async (url) => {
        expect(String(url)).toContain("/v1/runtime-connections");
        return Response.json({
          connections: [{ id: "pc", enabled: true, session: "owned", ssh: { host: "pc-owner", shell } }],
        });
      }) as typeof fetch,
    };
    const calls: { command: string; args: readonly string[]; interactive: boolean }[] = [];
    await openAgentHerdr(
      { ...terminal, connection: { kind: "ssh", ssh: { host: "pc-owner", shell } } },
      options,
      async (command, args, _env, interactive) => {
        calls.push({ command, args, interactive });
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.command === "ssh" && call.args.includes("pc-owner"))).toBe(true);
    expect(calls[0]?.interactive).toBe(false);
    expect(calls[1]?.args).toContain("-tt");
    expect(calls[1]?.interactive).toBe(true);
    if (shell === "posix") {
      expect(calls[0]?.args.at(-1)).toContain("'owned' 'agent' 'focus' 'w1:p2'");
      expect(calls[1]?.args.at(-1)).toContain("'owned' 'client'");
    } else {
      const script = Buffer.from(calls[1]!.args.at(-1)!.split(" ").at(-1)!, "base64").toString("utf16le");
      expect(script).toContain("& herdr '--session' 'owned' 'client'");
      expect(script).not.toContain("RedirectStandardOutput");
    }
    let attempts = 0;
    await expect(
      openAgentHerdr(
        { ...terminal, connection: { kind: "ssh", ssh: { host: "pc-owner", shell } } },
        options,
        async () => {
          attempts++;
          throw new Error("unreachable");
        },
      ),
    ).rejects.toThrow("unreachable");
    expect(attempts).toBe(1);
    await expect(
      openAgentHerdr(
        {
          ...terminal,
          runtime: { id: "pc", session: "other" },
          connection: { kind: "ssh", ssh: { host: "pc-owner", shell } },
        },
        options,
        async () => {
          throw new Error("must not run");
        },
      ),
    ).rejects.toThrow("session changed");
  },
);

it("refuses a same-ID, same-session connection replaced with another host or socket", async () => {
  const { openAgentHerdr } = await import("../src/session/herdr-connection.ts");
  const terminal = {
    runtime: { id: "pc", session: "owned" },
    terminalId: "pc/stable",
    label: "worker",
    workspace: { id: "w1", number: 1, label: "work" },
    tab: { id: "w1:t1", number: 1, label: "work" },
    pane: { id: "w1:p2" },
  };
  let calls = 0;
  const run = async () => {
    calls++;
  };
  const options = { repoRoot: "/checkout", env: { CLANKIE_OPERATOR_TOKEN: "owner" } };
  await expect(
    openAgentHerdr(
      { ...terminal, connection: { kind: "ssh", ssh: { host: "host-a", shell: "posix" } } },
      {
        ...options,
        fetchImpl: (async () =>
          Response.json({
            connections: [
              { id: "pc", enabled: true, session: "owned", ssh: { host: "host-b", shell: "posix" } },
            ],
          })) as typeof fetch,
      },
      run,
    ),
  ).rejects.toThrow("connection changed");
  await expect(
    openAgentHerdr(
      {
        ...terminal,
        runtime: { id: "default", session: "owned" },
        connection: {
          kind: "local",
          binding: { runtime: "external", session: "owned", socketPath: "/tmp/socket-a" },
        },
      },
      {
        ...options,
        fetchImpl: (async () =>
          Response.json({
            runtime: "external",
            session: "owned",
            socketPath: "/tmp/socket-b",
          })) as typeof fetch,
      },
      run,
    ),
  ).rejects.toThrow("connection changed");
  expect(calls).toBe(0);
});
