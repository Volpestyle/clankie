import { expect, it } from "vitest";
import type { Socket } from "node:net";
import { ancestors, clientPid, localFleetProof, localProjectProof } from "../src/local-fleet-proof.ts";
import {
  socketProcessFixture,
  projectProcessFixture,
  processFixtureStart,
} from "./helpers/local-fleet-process.ts";

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
    observeSocket: async (socket) => socketProcessFixture(socket, lsof, tree),
    run: async (command, args, env) => {
      expect(command).toBe("/trusted/herdr");
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
    await localFleetProof({ platform: "win32", herdrBinary: "herdr", binding: async () => binding })(
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
    observeSocket: async (socket) =>
      socketProcessFixture(
        socket,
        ++owners > 1 && changed === "owner" ? owner.replace("p55", "p56") : owner,
        "55 44\n44 33\n33 1\n",
      ),
    run: async (command) => {
      expect(command).toBe("/trusted/herdr");
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
  let looks = 0;
  let emptyLooks = 0;
  const prove = localProjectProof({
    platform: "darwin",
    launcher: async () => ({ executable: "/trusted/codex" }),
    canonical: async (path) => path,
    herdrBinary: "herdr",
    binding: async () => binding,
    observeSocket: async (socket) => {
      looks += 1;
      return emptyLooks-- > 0 ? undefined : socketProcessFixture(socket, owner, chain, nativeStart);
    },
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
      if (args[0] === "--processes")
        return projectProcessFixture(Number(args[1]), Number(args[2]), { start: nativeStart });
      if (command !== "herdr") throw new Error("Legacy process commands forbidden");
      return JSON.stringify({
        result: {
          process_info: { pane_id: args.at(-1), shell_pid: 33, foreground_process_group_id: foreground },
        },
      });
    },
  });
  const first = await prove(socket(), "w1:p1");
  expect(first?.processes).toEqual([{ pid: 44, startTime: processFixtureStart(nativeStart) }]);
  chain = "55 99\n99 33\n33 1\n44 33\n";
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  chain = "55 44\n44 33\n33 1\n";
  foreground = 99;
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  foreground = 44;
  nativeStart = "Sat Oct  3 10:00:01 2026";
  expect(await prove(socket(), "w1:p1")).not.toEqual(first);
  // #574: a first socket look that comes back empty is retried once, then refused.
  nativeStart = "Sat Oct  3 10:00:00 2026";
  looks = 0;
  emptyLooks = 1;
  expect(await prove(socket(), "w1:p1")).toEqual(first);
  expect(looks).toBe(3);
  looks = 0;
  emptyLooks = 2;
  expect(await prove(socket(), "w1:p1")).toBeUndefined();
  expect(looks).toBe(2);
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
    observeSocket: async (socket: Socket) =>
      socketProcessFixture(socket, owner, "55 99\n99 1\n44 33\n33 1\n"),
    privateSeat: async (chain: readonly number[], pane: string) => registry.allows(chain, pane, binding),
    privateProjectSeat: async (
      chain: readonly number[],
      pane: string,
      _binding: unknown,
      proof: { nativeOccupantId: string },
    ) => registry.allows(chain, pane, binding, proof.nativeOccupantId),
    run: async (command: string, args: string[]) => {
      if (args[0] === "--processes") return projectProcessFixture(Number(args[1]), Number(args[2]));
      if (command !== "herdr") throw new Error("Legacy process commands forbidden");
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
    observeSocket: async (socket) => socketProcessFixture(socket, owner, tree),
    run: async (command, args) => {
      if (args[0] === "--processes") return projectProcessFixture(Number(args[1]), Number(args[2]));
      if (command !== "herdr") throw new Error("Legacy process commands forbidden");
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
    observeSocket: async (socket) => {
      if (++owners === 2) final = true;
      if (final && changed === "closed") Object.assign(connected, { destroyed: true });
      const observedOwner =
        final && changed === "owner"
          ? owner.replace("p55", "p56")
          : final && changed === "duplicate"
            ? `${owner}p56\nn127.0.0.1:51000->127.0.0.1:42000\n`
            : owner;
      return socketProcessFixture(
        socket,
        observedOwner,
        final && changed === "ancestry" ? "55 99\n99 33\n33 1\n44 33\n" : "55 44\n44 33\n33 1\n",
      );
    },
    run: async (command, args) => {
      if (args[0] === "--processes") {
        if (final && changed === "unavailable") throw new Error("Process observation timed out");
        return projectProcessFixture(Number(args[1]), Number(args[2]), {
          executable: final && changed === "executable" ? "/untrusted/codex" : "/trusted/codex",
          start: `Sat Oct  3 10:00:0${final && changed === "lifetime" ? "1" : "0"} 2026`,
        });
      }
      if (command !== "herdr") throw new Error("Legacy process commands forbidden");
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

it("looks once more when the first socket observation comes back empty, and refuses after that (#574)", async () => {
  // A machine-wide census that runs out of its budget under load returns nothing and says nothing.
  const proof = (observations: ("empty" | "seen")[]) => {
    let looks = 0;
    const prove = localFleetProof({
      platform: "darwin",
      herdrBinary: "/trusted/herdr",
      binding: async () => binding,
      observeSocket: async (s) => {
        const next = observations[Math.min(looks++, observations.length - 1)];
        return next === "empty" ? undefined : socketProcessFixture(s, owner, "55 44\n44 33\n33 1\n");
      },
      run: async (_command, args) =>
        JSON.stringify({
          result: { process_info: { pane_id: args.at(-1), shell_pid: args.at(-1) === "w1:p1" ? 33 : 99 } },
        }),
    });
    return { prove, looks: () => looks };
  };
  // Empty once, then seen: admitted, with the initial look, its one retry and the final look.
  const recovered = proof(["empty", "seen"]);
  expect(await recovered.prove(socket(), "w1:p1")).toBe(true);
  expect(recovered.looks()).toBe(3);
  // Empty every time: refused after exactly one retry.
  const absent = proof(["empty"]);
  expect(await absent.prove(socket(), "w1:p1")).toBe(false);
  expect(absent.looks()).toBe(2);
  // A real non-member, seen at once, is refused without any retry.
  const outsider = proof(["seen"]);
  expect(await outsider.prove(socket(), "w1:p2")).toBe(false);
  expect(outsider.looks()).toBe(1);
});

it("looks once more under the same owner fence, and a changed owner is still refused (#613)", async () => {
  const tree = "55 44\n44 33\n33 1\n";
  const pinned = socketProcessFixture(socket(), owner, tree)!.owner;
  // The native helper refuses an owner other than the one it was asked to expect, with no
  // terminal reason, so that refusal reaches the retry; the retry must ask for the same owner.
  const proof = (expectedOwner: typeof pinned) => {
    const asked: (typeof pinned | undefined)[] = [];
    let looks = 0;
    const prove = localFleetProof({
      platform: "darwin",
      herdrBinary: "/trusted/herdr",
      binding: async () => binding,
      expectedOwner: () => expectedOwner,
      observeSocket: async (s, expected) => {
        asked.push(expected);
        if (looks++ === 0) return undefined;
        const seen = socketProcessFixture(s, owner, tree);
        return seen && expected && seen.owner.pid !== expected.pid ? undefined : seen;
      },
      run: async (_command, args) =>
        JSON.stringify({ result: { process_info: { pane_id: args.at(-1), shell_pid: 33 } } }),
    });
    return { prove, asked };
  };
  const same = proof(pinned);
  expect(await same.prove(socket(), "w1:p1")).toBe(true);
  expect(same.asked.slice(0, 2)).toEqual([pinned, pinned]);
  const changed = proof({ ...pinned, pid: 77 });
  expect(await changed.prove(socket(), "w1:p1")).toBe(false);
  expect(changed.asked).toEqual([
    { ...pinned, pid: 77 },
    { ...pinned, pid: 77 },
  ]);
});

it("runs concurrent requests' retries one at a time, so a burst under load doesn't pile on (#613)", async () => {
  const tree = "55 44\n44 33\n33 1\n";
  const looks = new Map<Socket, number>();
  let retrying = 0;
  let most = 0;
  const prove = localFleetProof({
    platform: "darwin",
    herdrBinary: "/trusted/herdr",
    binding: async () => binding,
    observeSocket: async (s) => {
      const look = looks.get(s) ?? 0;
      looks.set(s, look + 1);
      if (look === 0) return undefined;
      if (look === 1) {
        most = Math.max(most, ++retrying);
        await new Promise((resolve) => setTimeout(resolve, 20));
        retrying -= 1;
      }
      return socketProcessFixture(s, owner, tree);
    },
    run: async (_command, args) =>
      JSON.stringify({ result: { process_info: { pane_id: args.at(-1), shell_pid: 33 } } }),
  });
  const burst = [socket(), socket(), socket(), socket()];
  expect(await Promise.all(burst.map((s) => prove(s, "w1:p1")))).toEqual([true, true, true, true]);
  expect(most).toBe(1);
});

it("a desktop-app seat's proof looks once more too, and refuses after that (#613)", async () => {
  let looks = 0;
  const prove = localProjectProof({
    herdrBinary: "herdr",
    platform: "darwin",
    binding: async () => undefined,
    coreBinding: async () => ({
      runtime: "external" as const,
      session: "herdr-core",
      socketPath: "/core.sock",
    }),
    coreSeat: async () => ({ pid: 4242, agent: "claude", session: "s" }),
    launcher: async () => ({ executable: "/trusted/claude" }),
    observeSocket: async () => {
      looks += 1;
      return undefined;
    },
  });
  expect(await prove(socket(), "herdr-core/t3")).toBeUndefined();
  expect(looks).toBe(2);
});
