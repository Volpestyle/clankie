import type { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { localFleetProof, localProjectProof } from "../src/local-fleet-proof.ts";
import { createProjectMembershipResolver } from "../src/project-membership.ts";

function fixture() {
  const counts = { socket: 0, executable: 0 };
  const state = { cwd: "/code/project", start: "Sat Oct  3 10:00:00 2026", unavailable: false };
  const socket = {
    remoteAddress: "127.0.0.1",
    localAddress: "127.0.0.1",
    remotePort: 51000,
    localPort: 42000,
    destroyed: false,
    readable: true,
    writable: true,
  } as Socket;
  const options = {
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => ({ runtime: "external" as const, socketPath: "/host/socket", session: "default" }),
    launcher: async () => ({ executable: "/trusted/codex" }),
    canonical: async (path: string) => path,
    run: async (command: string, args: string[]) => {
      if (command === "/usr/sbin/lsof") {
        if (args.includes("txt")) {
          counts.executable++;
          if (state.unavailable) throw new Error("Process observation unavailable");
          return "p44\nftxt\nn/trusted/codex\n";
        }
        counts.socket++;
        return "p55\nn127.0.0.1:51000->127.0.0.1:42000\np80\nn127.0.0.1:42000->127.0.0.1:51000\n";
      }
      if (command === "/bin/ps")
        return args[0] === "-axo"
          ? "55 44\n44 33\n33 1\n"
          : `${state.start} ${Number(args[1]) === 33 ? "/bin/zsh" : "/trusted/codex"}\n`;
      if (args[0] === "agent")
        return JSON.stringify({
          result: {
            agent: {
              pane_id: "w1:p1",
              terminal_id: "terminal",
              agent: "codex",
              agent_session: { source: "codex", kind: "id", value: "session" },
            },
          },
        });
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: "w1:p1",
            shell_pid: 33,
            foreground_process_group_id: 44,
          },
        },
      });
    },
  };
  const fleetProof = localFleetProof(options);
  const projectProof = localProjectProof(options);
  const identity = {
    pane: "w1:p1",
    validate: () => fleetProof(socket, "w1:p1"),
    projectProof: vi.fn(() => projectProof(socket, "w1:p1")),
  };
  const resolve = createProjectMembershipResolver({
    settings: async () =>
      ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "project",
            name: "Project",
            workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: "/code/project" }],
          },
        ],
      }),
    hire: async () => ({ state: "none" as const }),
    canonical: async (path) => path,
    cwd: async () => state.cwd,
  });
  return { counts, state, identity, resolve: () => resolve(identity) };
}

it("bounds expensive OS scans per resolution while proving both checkpoints and every new request afresh", async () => {
  const f = fixture();
  const first = await f.resolve();
  expect(first).toMatchObject({ projectId: "project" });
  // Measured costs: about80ms/socket scan and50ms/executable scan. Recursive
  // proof passes consumed the startup window; retain two complete checkpoints.
  expect(f.counts.socket).toBeLessThanOrEqual(8);
  expect(f.counts.executable).toBeLessThanOrEqual(8);
  expect(f.identity.projectProof).toHaveBeenCalledTimes(2);
  f.state.start = "Sat Oct  3 10:00:01 2026";
  const replacement = await f.resolve();
  expect(replacement?.occupantId).not.toBe(first?.occupantId);
  expect(f.identity.projectProof).toHaveBeenCalledTimes(4);
  f.state.cwd = "/outside";
  expect(await f.resolve()).toBeUndefined();
  f.state.cwd = "/code/project";
  f.state.unavailable = true;
  expect(await f.resolve()).toBeUndefined();
});
