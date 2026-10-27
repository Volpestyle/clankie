import { randomBytes, randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { Hono } from "hono";
import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import { OPERATOR_SEAT_BINDINGS_PATH, OPERATOR_SEAT_BRIDGE_CLAIM_HEADER } from "@clankie/protocol";
import { OperatorSeatBindings, seatNonceHash } from "../../src/operator-seat-bindings.ts";

/** Controlled raw kernel observations for owned HTTP consumers, not native process acceptance. */
export function operatorSeatBindingFixture() {
  const sockets = new WeakMap<Socket, number>();
  const processes: { pid: number; ppid: number; birth: [string, string] }[] = [
    { pid: 100, ppid: 1, birth: [randomUUID(), "0"] },
    { pid: 101, ppid: 100, birth: [randomUUID(), "0"] },
    { pid: 102, ppid: 101, birth: [randomUUID(), "0"] },
  ];
  const launcher = { destroyed: false } as Socket;
  const bridge = { destroyed: false } as Socket;
  sockets.set(launcher, 100);
  sockets.set(bridge, 102);
  const launches = new Map<string, { nonce: string; launcher: Socket; bridge: Socket; harnessPid: number }>();
  const registry = new OperatorSeatBindings({
    birth: async (pid) => processes.find((p) => p.pid === pid)?.birth,
    processes: async (controller, harness) => {
      const pair = [controller, harness].map((pid) => processes.find((p) => p.pid === pid));
      if (pair.some((p) => !p)) return undefined;
      return {
        schemaVersion: 1,
        processes: pair.map((p) => ({ ...p!, uid: 501, executable: "/fixture/node", argv: [] })),
      };
    },
    socket: async (socket) => {
      const owner = processes.find((p) => p.pid === sockets.get(socket));
      if (!owner) return undefined;
      const ancestors = [owner];
      while (ancestors.at(-1)!.ppid !== 1) {
        const parent = processes.find((p) => p.pid === ancestors.at(-1)!.ppid);
        if (!parent) return undefined;
        ancestors.push(parent);
      }
      return {
        schemaVersion: 1,
        owner: { pid: owner.pid, uid: 501, birth: owner.birth, socket: "fixture-operator" },
        ancestors,
      };
    },
  });
  function launch(conversationId: string) {
    let entry = launches.get(conversationId);
    if (entry) return entry;
    entry = { nonce: randomBytes(32).toString("hex"), launcher, bridge, harnessPid: 101 };
    launches.set(conversationId, entry);
    return entry;
  }
  return {
    registry,
    headers: (id: string) => ({ [OPERATOR_SEAT_BRIDGE_CLAIM_HEADER]: launch(id).nonce }),
    env(_id: string): HttpBindings {
      return { incoming: { socket: bridge } } as HttpBindings;
    },
    /**
     * All clients of this owned HTTP server model one bridge process. Associate
     * its actual server socket with the predetermined kernel PID independently
     * of request headers; the real registry still compares the launch nonce.
     * This raw kernel stand-in does not prove native process acceptance.
     */
    httpEnv<T extends HttpBindings | Http2Bindings>(_request: Request, fallback?: T): T | undefined {
      if (fallback?.incoming.socket) sockets.set(fallback.incoming.socket, 102);
      return fallback;
    },
    async register(app: Pick<Hono, "request">, id: string, headers: Record<string, string> = {}) {
      const entry = launch(id);
      const response = await app.request(
        OPERATOR_SEAT_BINDINGS_PATH,
        {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: id,
            harnessPid: entry.harnessPid,
            nonceHash: seatNonceHash(entry.nonce),
          }),
        },
        { incoming: { socket: entry.launcher } } as HttpBindings,
      );
      if (response.status !== 200)
        throw new Error(`Fixture seat registration failed: ${response.status} ${await response.text()}`);
    },
  };
}
