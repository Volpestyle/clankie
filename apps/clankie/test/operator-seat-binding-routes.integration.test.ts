import type { Server as HttpServer } from "node:http";
import { request as httpRequest, Agent } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSeatRoutes } from "../src/app/seat-routes.ts";
import type { ClankieAppDependencies } from "../src/app/types.ts";
import type { NativeBirth, NativeSocketProcess } from "../src/local-fleet-process.ts";
import { OperatorSeatBindings, seatNonceHash } from "../src/operator-seat-bindings.ts";

/**
 * VUH-2816 at the service boundary: real HTTP sockets into the real seat routes
 * and the real registry. Each stand-in process is a client bound to a fixed
 * local port, and the stand-in kernel maps that port to a pid and parent chain,
 * answering what the native helper would. No harness, launcher, inbox or
 * credential is real.
 */
const BEARER = "scratch-bearer";
const NONCE = "launch-nonce";
// pid by client port; parent pid by pid. 10 launcher -> 20 harness -> 30 bridge;
// 20 -> 25 shell -> 31 nested stray; 40 unrelated.
const PORT: Record<number, number> = { 10: 41010, 30: 41030, 31: 41031, 40: 41040, 32: 41032 };
const PARENT: Record<number, number> = { 10: 5, 20: 10, 25: 20, 30: 20, 31: 25, 32: 20, 40: 5, 5: 1, 1: 0 };
let alive: Set<number>;
let server: HttpServer;
let hits: string[];

const birth = (pid: number): NativeBirth => Object.assign([String(pid), "0"] as [string, string], {});

function kernel() {
  const owners = new Map<number, number>(Object.entries(PORT).map(([pid, port]) => [port, Number(pid)]));
  return {
    birth: async (pid: number) => (alive.has(pid) ? birth(pid) : undefined),
    processes: async (controller: number, harness: number) => {
      if (![controller, harness].every((pid) => alive.has(pid))) return undefined;
      return {
        schemaVersion: 1 as const,
        processes: [controller, harness].map((pid) => ({
          pid,
          ppid: PARENT[pid]!,
          uid: 501,
          birth: [String(pid), "0"] as [string, string],
          executable: "/fixture/node",
          argv: [],
        })),
      };
    },
    socket: async (socket: Socket): Promise<NativeSocketProcess | undefined> => {
      const owner = owners.get(socket.remotePort ?? 0);
      if (owner === undefined) return undefined;
      const ancestors = [];
      for (let pid = owner; alive.has(pid); pid = PARENT[pid]!)
        ancestors.push({ pid, ppid: PARENT[pid]!, birth: [String(pid), "0"] as [string, string] });
      return {
        schemaVersion: 1,
        owner: { pid: owner, uid: 501, birth: [String(owner), "0"], socket: "s" },
        ancestors,
      };
    },
  };
}

beforeEach(async () => {
  alive = new Set([1, 5, 10, 20, 25, 30, 31, 32, 40]);
  hits = [];
  const app = new Hono();
  registerSeatRoutes({
    app,
    authenticateLane: async (context) =>
      context.req.header("authorization") === `Bearer ${BEARER}`
        ? { lane: "operator" }
        : { denial: context.json({ error: "unauthorized" }, 401) },
    dependencies: {
      operatorSeatBindings: new OperatorSeatBindings(kernel()),
      captain: {
        seatContext: (id?: string) => ({ conversationId: id ?? "global-default", cwd: "/scratch" }),
        laneToolBank: async () => ({ lane: "operator", tools: [] }),
        pollSeatEvents: async (_wait: number, _signal: unknown, conversationId?: string) => {
          hits.push(`poll:${conversationId}`);
          return [];
        },
        acknowledgeSeatEvent: async (id: string) => {
          hits.push(`ack:${id}`);
          return true;
        },
        replySeatEvent: async (id: string) => {
          hits.push(`reply:${id}`);
          return true;
        },
      },
    } as unknown as ClankieAppDependencies,
  });
  server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }) as HttpServer;
  await new Promise<void>((resolve) => server.once("listening", resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** One request from the stand-in process `pid`, from its fixed local port. */
function call(
  pid: number,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const agent = new Agent({ keepAlive: false });
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        localPort: PORT[pid]!,
        method,
        path,
        agent,
        headers: {
          authorization: `Bearer ${BEARER}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          agent.destroy();
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
        });
      },
    );
    request.on("error", reject);
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

const register = (pid = 10, conversationId = "seat-a") =>
  call(pid, "PUT", "/v1/captain/seat-bindings", {
    body: { conversationId, harnessPid: 20, nonceHash: seatNonceHash(NONCE) },
  });
const poll = (pid: number, query = "?conversationId=seat-a&wait=0", claim: string | null = NONCE) =>
  call(pid, "GET", `/v1/seat/events${query}`, {
    headers: claim === null ? {} : { "x-clankie-bridge-claim": claim },
  });

describe("operator seat routes", () => {
  it("refuse every caller until a launcher registers, with no global-default fallback", async () => {
    expect((await poll(30)).body.error).toBe("seat_binding_required");
    expect((await poll(30, "?wait=0")).body.error).toBe("seat_binding_conversation_required");
    expect((await call(30, "POST", "/v1/seat/events/e1/ack?conversationId=seat-a")).status).toBe(403);
    expect(hits).toEqual([]);
  });

  it("serve the registered bridge and the registered launcher", async () => {
    expect((await register()).status).toBe(200);
    expect((await poll(30)).status).toBe(200);
    expect((await poll(10, "?conversationId=seat-a&wait=0", null)).status).toBe(200);
    expect(
      (
        await call(30, "POST", "/v1/seat/events/e1/ack?conversationId=seat-a", {
          headers: { "x-clankie-bridge-claim": NONCE },
        })
      ).status,
    ).toBe(200);
    expect(hits).toEqual(["poll:seat-a", "poll:seat-a", "ack:e1"]);
  });

  it("refuse a nested stray that shares the genuine ancestors and the nonce", async () => {
    await register();
    for (const [method, path] of [
      ["GET", "/v1/seat/events?conversationId=seat-a&wait=0"],
      ["POST", "/v1/seat/events/e1/ack?conversationId=seat-a"],
      ["POST", "/v1/seat/events/e1/reply?conversationId=seat-a"],
      ["POST", "/v1/mcp?conversationId=seat-a"],
    ] as const) {
      const refused = await call(31, method, path, {
        headers: { "x-clankie-bridge-claim": NONCE },
        ...(method === "POST" ? { body: { text: "hi" } } : {}),
      });
      expect([refused.status, refused.body.error]).toEqual([403, "seat_bridge_not_registered"]);
    }
    expect(hits).toEqual([]);
  });

  it("refuse the wrong conversation, a wrong claim, an unrelated process and a second claimant", async () => {
    await register();
    expect((await poll(30, "?conversationId=seat-b&wait=0")).body.error).toBe("seat_binding_required");
    expect((await poll(30, undefined, "guess")).body.error).toBe("seat_bridge_claim_invalid");
    expect((await poll(30, undefined, null)).status).toBe(403);
    expect((await poll(40)).body.error).toBe("seat_bridge_not_registered");
    expect((await poll(30)).status).toBe(200);
    expect((await poll(32)).body.error).toBe("seat_bridge_claimed");
  });

  it("drop a binding whose harness pid was reused or whose launcher died", async () => {
    await register();
    alive.delete(10);
    expect((await poll(30)).body.error).toBe("seat_binding_stale");
    expect((await poll(30)).body.error).toBe("seat_binding_required");
  });

  it("let only a real controller register, and not take over a live one", async () => {
    expect((await register(40)).body.error).toBe("seat_harness_not_child");
    expect((await register()).status).toBe(200);
    expect((await register(31)).body.error).toBe("seat_harness_not_child");
    const status = await call(40, "GET", "/v1/captain/seat-bindings");
    expect(status.body).toMatchObject({
      available: true,
      bindings: [{ conversationId: "seat-a" }],
      lastRefusal: { error: "seat_harness_not_child", recovery: expect.stringContaining("direct child") },
    });
    expect(JSON.stringify(status.body)).not.toContain(seatNonceHash(NONCE));
  });

  it("leave bearer-only routes alone for the CLI", async () => {
    expect((await call(40, "GET", "/v1/captain/seat-context?conversationId=seat-a")).status).toBe(200);
  });

  it("refuse an in-process caller that has no socket to prove", async () => {
    const app = new Hono();
    registerSeatRoutes({
      app,
      authenticateLane: async () => ({ lane: "operator" }),
      dependencies: {
        operatorSeatBindings: new OperatorSeatBindings(kernel()),
        captain: { seatContext: () => ({ conversationId: "seat-a", cwd: "/" }) },
      } as unknown as ClankieAppDependencies,
    });
    const response = await app.fetch(new Request("http://x/v1/seat/events?conversationId=seat-a&wait=0"));
    expect(response.status).toBe(403);
  });
});
