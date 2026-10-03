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
