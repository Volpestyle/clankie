import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { runMcpCommand } from "../src/command/mcp.ts";
import { registerSeatBinding } from "../src/command/seat-binding.ts";

/**
 * VUH-2816: a bridge with no verified seat binding must not fall back to the
 * owner's `global-default` lead conversation. The control server here is a
 * loopback stand-in that records every request; nothing reaches the real
 * service, inbox or broker.
 */
const SESSION = "6f1c2a52-6a53-4a77-9a6e-0a3f2f6c7b11";
const CHANNEL = "--dangerously-load-development-channels server:clankie";

let root: string;
let server: Server;
let host: string;
let requests: { method: string; url: string; claim: string; body: string }[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clankie-unbound-bridge-"));
  requests = [];
  server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      claim: String(request.headers["x-clankie-bridge-claim"] ?? ""),
      body: "",
    });
    request.on("data", (chunk) => (requests.at(-1)!.body += chunk));
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "stand-in" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

function scratchEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    CLANKIE_STATE_HOME: join(root, "state"),
    CLANKIE_CONTROL_PLANE_URL: host,
    CLANKIE_OPERATOR_TOKEN: "scratch-bearer",
    ...extra,
  };
}

function run(env: NodeJS.ProcessEnv, parentArgv: string, args: string[] = ["--lane", "operator"]) {
  const [, serverTransport] = InMemoryTransport.createLinkedPair();
  return runMcpCommand(args, {
    env,
    host,
    readParentArgv: async () => parentArgv,
    transport: serverTransport,
    stderr: { write: () => undefined },
    pollWaitMs: 10,
    pollRetryMs: 10,
  });
}

describe("an unbound operator bridge", () => {
  it.each([
    ["no seat or conversation env", {}],
    [
      "only a harness marker and session id",
      { CLANKIE_SEAT_HARNESS: "claude", CLANKIE_SEAT_SESSION_ID: SESSION },
    ],
  ])("fails closed with %s, never touching the lead's conversation", async (_name, extra) => {
    await expect(run(scratchEnv(extra), `claude ${CHANNEL}`)).rejects.toThrow(/no seat binding/u);
    // No poll, report read, acknowledgement or message_seat can have been issued.
    expect(requests).toEqual([]);
  });

  it("names the recovery in its diagnostic", async () => {
    await expect(run(scratchEnv(), `claude ${CHANNEL}`)).rejects.toThrow(
      /will not default to the global lead conversation.*clankie claude/su,
    );
  });
});

describe("a bridge its launcher bound", () => {
  it("asks the service for its own conversation and presents the launch nonce", async () => {
    const env = scratchEnv({ CLANKIE_CONVERSATION_ID: "workspace-7", CLANKIE_BRIDGE_NONCE: "launch-nonce" });
    // The stand-in service answers 404, so connecting fails after the request:
    // what matters is what the bridge asked for and proved.
    await run(env, `claude ${CHANNEL}`).catch(() => undefined);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(new URL(request.url, host).searchParams.get("conversationId")).toBe("workspace-7");
      expect(request.claim).toBe("launch-nonce");
    }
  });
});

describe("private bridge nonce file", () => {
  it("reads only the bridge-specific file and forwards its claim through real HTTP", async () => {
    const path = join(root, "nonce");
    const nonce = "a".repeat(64);
    await writeFile(path, nonce, { mode: 0o600 });
    await run(
      scratchEnv({ CLANKIE_CONVERSATION_ID: "workspace-7", CLANKIE_BRIDGE_NONCE_FILE: path }),
      `claude ${CHANNEL}`,
    ).catch(() => undefined);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.claim === nonce)).toBe(true);
  });

  it("refuses a missing or public nonce file without contacting the service", async () => {
    const path = join(root, "unsafe-nonce");
    const env = scratchEnv({ CLANKIE_CONVERSATION_ID: "workspace-7", CLANKIE_BRIDGE_NONCE_FILE: path });
    await expect(run(env, `claude ${CHANNEL}`)).rejects.toThrow(/seat_bridge_claim_invalid.*Relaunch/u);
    await writeFile(path, "b".repeat(64), { mode: 0o644 });
    await expect(run(env, `claude ${CHANNEL}`)).rejects.toThrow(/seat_bridge_claim_invalid.*Relaunch/u);
    expect(requests).toEqual([]);
  });
});

describe("a launcher registering its harness", () => {
  it("retains the registration refusal status when its response body is malformed", async () => {
    server.removeAllListeners("request");
    server.on("request", (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("not JSON");
    });
    const warnings: string[] = [];
    const binding = registerSeatBinding(
      { conversationId: "workspace-7", harnessPid: 4242, nonce: "launch-nonce" },
      { env: scratchEnv(), host, warn: (message) => warnings.push(message) },
    );
    await binding.ready;
    expect(warnings).toEqual(["seat binding refused (503); its bridge stays locked out until it registers"]);
    await binding.stop();
  });

  it.each(["HTTP refusal", "transport disconnect"])(
    "warns safely without rejecting cleanup after a withdrawal %s",
    async (failure) => {
      server.removeAllListeners("request");
      server.on("request", (request, response) => {
        if (request.method === "DELETE") {
          if (failure === "transport disconnect") {
            request.socket.destroy();
            return;
          }
          response.writeHead(503);
          response.end("launch-nonce scratch-bearer");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
      const warnings: string[] = [];
      const binding = registerSeatBinding(
        { conversationId: "workspace-7", harnessPid: 4242, nonce: "launch-nonce" },
        { env: scratchEnv(), host, warn: (message) => warnings.push(message) },
      );
      await binding.ready;
      expect(warnings).toEqual([]);
      await expect(binding.stop()).resolves.toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("seat binding withdrawal");
      expect(warnings[0]).toContain(failure === "HTTP refusal" ? "503" : "unavailable");
      expect(warnings[0]).toContain("native process");
      expect(warnings.join("\n")).not.toMatch(/launch-nonce|scratch-bearer/u);
    },
  );

  it("sends the harness pid and only a hash of the nonce, heartbeats, and withdraws on stop", async () => {
    const binding = registerSeatBinding(
      { conversationId: "workspace-7", harnessPid: 4242, nonce: "launch-nonce", depth: 2 },
      { env: scratchEnv(), host, intervalMs: 20 },
    );
    await binding.ready;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await binding.stop();
    const puts = requests.filter((request) => request.method === "PUT");
    expect(puts.length).toBeGreaterThan(1);
    const sent = JSON.parse(puts[0]!.body);
    expect(sent).toEqual({
      conversationId: "workspace-7",
      harnessPid: 4242,
      nonceHash: createHash("sha256").update("launch-nonce").digest("hex"),
      depth: 2,
    });
    expect(puts.every((request) => !request.body.includes("launch-nonce"))).toBe(true);
    expect(requests.at(-1)).toMatchObject({ method: "DELETE" });
    expect(new URL(requests.at(-1)!.url, host).searchParams.get("conversationId")).toBe("workspace-7");
  });
});
