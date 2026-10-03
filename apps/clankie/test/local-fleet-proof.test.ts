import { expect, it } from "vitest";
import type { Socket } from "node:net";
import { ancestors, clientPid, localFleetProof } from "../src/local-fleet-proof.ts";

const socket = () =>
  ({
    remoteAddress: "127.0.0.1",
    localAddress: "127.0.0.1",
    remotePort: 51000,
    localPort: 42000,
    destroyed: false,
    readable: true,
    writable: true,
  }) as Socket;
const binding = { runtime: "external" as const, socketPath: "/trusted/default.sock", session: "default" };
const owner = "p55\nn127.0.0.1:51000->127.0.0.1:42000\np80\nn127.0.0.1:42000->127.0.0.1:51000\n";
function fixture() {
  let live = true;
  let tree = "55 44\n44 33\n33 1\n";
  let lsof = owner;
  let privateSeat = false;
  const connected = socket();
  const prove = localFleetProof({
    platform: "darwin",
    herdrBinary: "/trusted/herdr",
    binding: async () => (live ? binding : undefined),
    privateSeat: async (chain, pane) => privateSeat && chain.includes(44) && pane === "w1:p1",
    run: async (command, args, env) => {
      if (command === "/usr/sbin/lsof") return lsof;
      if (command === "/bin/ps") return tree;
      expect(env?.HERDR_SOCKET_PATH).toBe("/trusted/default.sock");
      expect(args.slice(0, 2)).toEqual(["pane", "process-info"]);
      return JSON.stringify({
        result: { process_info: { pane_id: args.at(-1), shell_pid: args.at(-1) === "w1:p1" ? 33 : 99 } },
      });
    },
  });
  return {
    prove,
    connected,
    drop: () => {
      live = false;
    },
    ancestry: (s: string) => {
      tree = s;
    },
    owner: (s: string) => {
      lsof = s;
    },
    privateSeat: (s: boolean) => {
      privateSeat = s;
    },
  };
}
it("accepts only the unique OS-observed client endpoint owner", () => {
  expect(clientPid(owner, 51000, 42000)).toBe(55);
  expect(clientPid(`${owner}p56\nn127.0.0.1:51000->127.0.0.1:42000\n`, 51000, 42000)).toBeUndefined();
  expect(clientPid(owner, 51001, 42000)).toBeUndefined();
  expect(ancestors("55 44\n", 55)).toEqual([]);
});
it("admits the real pane descendant, rejects forged other pane and revoked binding", async () => {
  const f = fixture();
  expect(await f.prove(f.connected, "w1:p1")).toBe(true);
  expect(await f.prove(f.connected, "w1:p2")).toBe(false);
  f.drop();
  expect(await f.prove(f.connected, "w1:p1")).toBe(false);
});
it("rejects closed sockets, lost ancestry and absent kernel owners", async () => {
  const f = fixture();
  Object.assign(f.connected, { destroyed: true });
  expect(await f.prove(f.connected, "w1:p1")).toBe(false);
  Object.assign(f.connected, { destroyed: false });
  f.ancestry("55 44\n44 1\n");
  expect(await f.prove(f.connected, "w1:p1")).toBe(false);
  f.owner("");
  expect(await f.prove(f.connected, "w1:p1")).toBe(false);
});
it("permits service-owned private seats only while their exact registry entry remains active", async () => {
  const f = fixture();
  f.ancestry("55 44\n44 1\n");
  f.privateSeat(true);
  expect(await f.prove(f.connected, "w1:p1")).toBe(true);
  expect(await f.prove(f.connected, "w1:p2")).toBe(false);
  f.privateSeat(false);
  expect(await f.prove(f.connected, "w1:p1")).toBe(false);
});
it("fails closed on unsupported platforms", async () => {
  expect(
    await localFleetProof({ platform: "linux", herdrBinary: "herdr", binding: async () => binding })(
      socket(),
      "w1:p1",
    ),
  ).toBe(false);
});

it.each(["owner", "binding", "socket"])("rejects a changed %s during native proof", async (changed) => {
  const connected = socket();
  let owners = 0;
  let bindings = 0;
  const prove = localFleetProof({
    platform: "darwin",
    herdrBinary: "/trusted/herdr",
    binding: async () =>
      ++bindings > 1 && changed === "binding" ? { ...binding, session: "another" } : binding,
    run: async (command) => {
      if (command === "/usr/sbin/lsof")
        return ++owners > 1 && changed === "owner" ? owner.replace("p55", "p56") : owner;
      if (command === "/bin/ps") return "55 44\n44 33\n33 1\n";
      if (changed === "socket") Object.assign(connected, { destroyed: true });
      return JSON.stringify({ result: { process_info: { pane_id: "w1:p1", shell_pid: 33 } } });
    },
  });
  expect(await prove(connected, "w1:p1")).toBe(false);
});

it("project proof requires the socket to descend from the current native agent, not another job in its pane", async () => {
  const { localProjectProof } = await import("../src/local-fleet-proof.ts");
  let chain = "55 44\n44 33\n33 1\n";
  let foreground = 44;
  let nativeStart = "Sat Oct  3 10:00:00 2026";
  const prove = localProjectProof({
    platform: "darwin",
    launcher: async () => ({ executable: "/trusted/codex" }),
    canonical: async (path) => path,
    herdrBinary: "herdr",
    binding: async () => binding,
    run: async (command, args) => {
      if (command === "herdr" && args[0] === "agent")
        return JSON.stringify({
          result: {
            agent: {
              pane_id: args.at(-1),
              terminal_id: "terminal",
              agent: "codex",
              agent_session: { source: "codex", kind: "id", value: "session" },
            },
          },
        });
      if (command === "/usr/sbin/lsof") return args.includes("txt") ? "p44\nftxt\nn/trusted/codex\n" : owner;
      if (command === "/bin/ps" && args[0] === "-axo") return chain;
      if (command === "/bin/ps")
        return `${nativeStart} ${Number(args[1]) === 33 ? "/bin/zsh" : "/usr/local/bin/codex"}\n`;
      return JSON.stringify({
        result: {
          process_info: { pane_id: args.at(-1), shell_pid: 33, foreground_process_group_id: foreground },
        },
      });
    },
  });
  const first = await prove(socket(), "w1:p1");
  expect(first?.processes).toEqual([{ pid: 44, startTime: nativeStart }]);
  chain = "55 99\n99 33\n33 1\n44 33\n";
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  chain = "55 44\n44 33\n33 1\n";
  foreground = 99;
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  foreground = 44;
  nativeStart = "Sat Oct  3 10:00:01 2026";
  expect(await prove(socket(), "w1:p1")).not.toEqual(first);
});

it("admits only a live registered private server matching the foreground native thread", async () => {
  const { localProjectProof } = await import("../src/local-fleet-proof.ts");
  const { LocalCodexSeats } = await import("../src/local-codex-seats.ts");
  let serverStart = "server-start";
  let nativeThread = "thread";
  const registry = new LocalCodexSeats(
    () => binding,
    async () => serverStart,
  );
  const registration = registry.register(99, "w1:p1");
  const options = {
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => binding,
    launcher: async () => ({ executable: "/trusted/codex" }),
    canonical: async (path: string) => path,
    privateSeat: async (chain: readonly number[], pane: string) => registry.allows(chain, pane, binding),
    privateProjectSeat: async (
      chain: readonly number[],
      pane: string,
      _binding: unknown,
      proof: { nativeOccupantId: string },
    ) => registry.allows(chain, pane, binding, proof.nativeOccupantId),
    run: async (command: string, args: string[]) => {
      if (command === "/usr/sbin/lsof") return args.includes("txt") ? "p44\nftxt\nn/trusted/codex\n" : owner;
      if (command === "/bin/ps" && args[0] === "-axo") return "55 99\n99 1\n44 33\n33 1\n";
      if (command === "/bin/ps")
        return `Sat Oct  3 10:00:00 2026 ${Number(args[1]) === 33 ? "/bin/zsh" : "/trusted/codex"}\n`;
      if (args[0] === "agent")
        return JSON.stringify({
          result: {
            agent: {
              pane_id: args.at(-1),
              terminal_id: "terminal",
              agent: "codex",
              agent_session: { source: "herdr:codex", kind: "id", value: nativeThread },
            },
          },
        });
      return JSON.stringify({
        result: { process_info: { pane_id: args.at(-1), shell_pid: 33, foreground_process_group_id: 44 } },
      });
    },
  };
  const prove = localProjectProof(options);
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  registration.bindSession?.("thread");
  expect(await prove(socket(), "w1:p1")).toMatchObject({ privateSeat: true, processes: [{ pid: 44 }] });
  expect(await prove(socket(), "w1:p2")).toBeUndefined();
  nativeThread = "replacement-thread";
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  nativeThread = "thread";
  serverStart = "reused";
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  serverStart = "server-start";
  registration.bindSession?.("replacement-thread");
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  registration();
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
});

it("allows a sessionless owner process only through its own socket ancestry, never a private seat", async () => {
  const { localProjectProof } = await import("../src/local-fleet-proof.ts");
  let tree = "55 44\n44 33\n33 1\n";
  const prove = localProjectProof({
    platform: "darwin",
    binding: async () => binding,
    herdrBinary: "herdr",
    launcher: async () => ({ executable: "/trusted/codex" }),
    canonical: async (path) => path,
    privateSeat: async () => true,
    privateProjectSeat: async () => true,
    run: async (command, args) => {
      if (command === "/usr/sbin/lsof") return args.includes("txt") ? "p44\nftxt\nn/trusted/codex\n" : owner;
      if (command === "/bin/ps" && args[0] === "-axo") return tree;
      if (command === "/bin/ps") return "Sat Oct  3 10:00:00 2026 /trusted/codex\n";
      if (args[0] === "agent")
        return JSON.stringify({
          result: { agent: { pane_id: "w1:p1", terminal_id: "terminal", agent: "codex" } },
        });
      return JSON.stringify({
        result: { process_info: { pane_id: "w1:p1", shell_pid: 33, foreground_process_group_id: 44 } },
      });
    },
  });
  expect(await prove(socket(), "w1:p1")).toMatchObject({ nativeSessionPending: true });
  expect(await prove(socket(), "w1:p2")).toBeUndefined();
  tree = "55 99\n99 1\n44 33\n33 1\n";
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
});

it.each([
  "owner",
  "duplicate",
  "ancestry",
  "foreground",
  "lifetime",
  "session",
  "executable",
  "binding",
  "closed",
  "unavailable",
])("rejects %s changing at the final parallel project-proof checkpoint", async (changed) => {
  const { localProjectProof } = await import("../src/local-fleet-proof.ts");
  const connected = socket();
  let final = false;
  let owners = 0;
  const prove = localProjectProof({
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => (final && changed === "binding" ? undefined : binding),
    launcher: async () => ({ executable: "/trusted/codex" }),
    canonical: async (path) => path,
    run: async (command, args) => {
      if (command === "/usr/sbin/lsof") {
        if (args.includes("txt")) {
          if (final && changed === "unavailable") throw new Error("Process observation timed out");
          return `p44\nftxt\nn${final && changed === "executable" ? "/untrusted/codex" : "/trusted/codex"}\n`;
        }
        if (++owners === 2) final = true;
        if (final && changed === "closed") Object.assign(connected, { destroyed: true });
        if (final && changed === "owner") return owner.replace("p55", "p56");
        if (final && changed === "duplicate") return `${owner}p56\nn127.0.0.1:51000->127.0.0.1:42000\n`;
        return owner;
      }
      if (command === "/bin/ps") {
        if (args[0] === "-axo")
          return final && changed === "ancestry" ? "55 99\n99 33\n33 1\n44 33\n" : "55 44\n44 33\n33 1\n";
        return `Sat Oct  3 10:00:0${final && changed === "lifetime" ? "1" : "0"} 2026 ${Number(args[1]) === 33 ? "/bin/zsh" : "/trusted/codex"}\n`;
      }
      if (args[0] === "agent")
        return JSON.stringify({
          result: {
            agent: {
              pane_id: "w1:p1",
              terminal_id: "terminal",
              agent: "codex",
              agent_session: {
                source: "codex",
                kind: "id",
                value: final && changed === "session" ? "replacement" : "session",
              },
            },
          },
        });
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: "w1:p1",
            shell_pid: 33,
            foreground_process_group_id: final && changed === "foreground" ? 99 : 44,
          },
        },
      });
    },
  });
  expect(await prove(connected, "w1:p1")).toBeUndefined();
});
