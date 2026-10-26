import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerSeatRoutes } from "../src/app/seat-routes.ts";
import type { ClankieAppDependencies } from "../src/app/types.ts";
import {
  fleetProcessHelper,
  observeNativeBirth,
  observeNativeProcesses,
  observeSocketProcess,
} from "../src/local-fleet-process.ts";
import { OperatorSeatBindings, seatNonceHash } from "../src/operator-seat-bindings.ts";

interface Fixture {
  role: string;
  pid: number;
  port: number;
  descendants: Fixture[];
}
interface Reply {
  status: number;
  body: Record<string, unknown>;
  localPort: number;
}
const helper = fleetProcessHelper();
const nonce = "a".repeat(64);

// Missing native proof is explicitly unavailable; never silently replace it with fake births.
describe.skipIf(!existsSync(helper) || !["darwin", "linux"].includes(process.platform))(
  "operator seat real native socket boundary (requires native helper)",
  () => {
    it("binds only the launcher child and its nonce-bearing bridge, across refresh, restart and exits", async () => {
      expect(
        await observeNativeBirth(process.pid),
        "native helper must actually observe a live process",
      ).toBeDefined();
      const fixtures: Fixture[] = [];
      const root = spawn(
        process.execPath,
        [new URL("./fixtures/operator-seat-binding-native.mjs", import.meta.url).pathname, "launcher"],
        { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_ENV: "test" } },
      );
      let server: Server | undefined;
      const nonceRoot = await mkdtemp(join(tmpdir(), "native-mcp-"));
      const nonceFile = join(nonceRoot, "claim");
      await writeFile(nonceFile, nonce, { mode: 0o600 });
      const remember = (fixture: Fixture): Fixture => {
        fixtures.push(fixture);
        fixture.descendants.forEach(remember);
        return fixture;
      };
      const launcher = remember(
        await new Promise<Fixture>((resolve, reject) => {
          let output = "";
          root.stdout!.on("data", (chunk) => {
            output += chunk;
            if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]!));
          });
          root.once("error", reject);
          root.once("exit", (code) => {
            if (!output.includes("\n")) reject(new Error(`launcher exited ${code}`));
          });
        }),
      );
      const harness = launcher.descendants[0]!;
      const [bridge, sibling, shell] = harness.descendants;
      const nested = shell!.descendants[0]!;
      try {
        const app = new Hono();
        const hits: string[] = [];
        const mcpBanks: string[] = [];
        const makeRegistry = () =>
          new OperatorSeatBindings({
            socket: (socket) => observeSocketProcess(socket, helper),
            birth: observeNativeBirth,
            processes: (controllerPid, harnessPid) => observeNativeProcesses(controllerPid, harnessPid),
          });
        const dependencies = {
          operatorSeatBindings: makeRegistry(),
          captain: {
            laneToolBank: async (_lane: string, id: string) => {
              mcpBanks.push(id);
              return { lane: "operator", tools: [] };
            },
            seatContext: (conversationId?: string) => ({ conversationId, cwd: "/native-fixture" }),
            pollSeatEvents: async (_wait: number, _signal: unknown, id?: string) => {
              hits.push(id!);
              return [];
            },
          },
        } as unknown as ClankieAppDependencies;
        registerSeatRoutes({
          app,
          authenticateLane: async (context) =>
            context.req.header("authorization") === "Bearer native-fixture"
              ? { lane: "operator" }
              : { denial: context.json({ error: "unauthorized" }, 401) },
          dependencies,
        });
        server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }) as Server;
        await new Promise<void>((resolve) => server!.once("listening", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const command = async (fixture: Fixture, input: unknown): Promise<Reply> => {
          const response = await fetch(`http://127.0.0.1:${fixture.port}`, {
            method: "POST",
            body: JSON.stringify(input),
          });
          return response.json() as Promise<Reply>;
        };
        const register = (fixture = launcher, pid = harness.pid) =>
          command(fixture, {
            url: `${origin}/v1/captain/seat-bindings`,
            method: "PUT",
            body: { conversationId: "native-seat", harnessPid: pid, nonceHash: seatNonceHash(nonce) },
          });
        const poll = (fixture = bridge!, claim: string | undefined = nonce) =>
          command(fixture, {
            url: `${origin}/v1/seat/events?conversationId=native-seat&wait=0`,
            headers: claim === undefined ? {} : { "x-clankie-bridge-claim": claim },
          });
        expect((await poll()).body.error).toBe("seat_binding_required");
        // A process with the bearer cannot nominate somebody else's harness.
        expect((await register(sibling!)).status).toBe(403);
        expect((await register()).status).toBe(200);
        expect((await poll(bridge!, "wrong")).body.error).toBe("seat_bridge_claim_invalid");
        expect(
          (await command(bridge!, { url: `${origin}/v1/seat/events?conversationId=native-seat&wait=0` })).body
            .error,
        ).toBe("seat_bridge_claim_invalid");
        expect((await poll(nested)).body.error).toBe("seat_bridge_not_registered");
        for (const path of ["/v1/seat/events/e1/ack", "/v1/seat/events/e1/reply", "/v1/mcp"]) {
          const refusal = await command(nested, {
            url: `${origin}${path}?conversationId=native-seat`,
            method: "POST",
            headers: { "x-clankie-bridge-claim": nonce },
            body: { text: "fixture" },
          });
          expect([refusal.status, refusal.body.error]).toEqual([403, "seat_bridge_not_registered"]);
        }
        const first = await poll();
        expect(first.status).toBe(200);
        const second = await poll();
        expect(second.status).toBe(200);
        expect(second.localPort).toBe(first.localPort); // Real HTTP keep-alive socket.
        expect((await poll(sibling!)).body.error).toBe("seat_bridge_claimed");
        expect((await register()).status).toBe(200); // Heartbeat must preserve the claimant.
        expect((await poll(sibling!)).body.error).toBe("seat_bridge_claimed");
        // A service registry restart refuses the old bridge before launcher recovery.
        dependencies.operatorSeatBindings = makeRegistry();
        expect((await register(sibling!)).status).toBe(403); // Squatter races the first launcher heartbeat.
        expect((await poll(sibling!)).body.error).toBe("seat_binding_required");
        expect((await poll()).body.error).toBe("seat_binding_required");
        expect((await register()).status).toBe(200);
        expect((await poll()).status).toBe(200);
        process.kill(bridge!.pid, "SIGTERM");
        await expect.poll(() => observeNativeBirth(bridge!.pid)).toBeUndefined();
        const replacement = remember(
          (await command(harness, { spawn: "replacement" })) as unknown as Fixture,
        );
        expect((await poll(replacement)).status).toBe(200); // Genuine new native direct child.
        process.kill(replacement.pid, "SIGTERM");
        await expect.poll(() => observeNativeBirth(replacement.pid)).toBeUndefined();
        expect(await command(sibling!, { environment: true })).toEqual({
          filePresent: false,
          rawPresent: false,
        });
        const actualMcp = await command(harness, { spawnMcp: true, origin, file: nonceFile });
        expect(actualMcp).toMatchObject({
          tools: expect.arrayContaining(["reply"]),
          exit: 0,
          filePresent: true,
          rawPresent: false,
        });
        expect(mcpBanks).toContain("native-seat");
        process.kill(harness.pid, "SIGTERM");
        await expect.poll(() => observeNativeBirth(harness.pid)).toBeUndefined();
        expect((await poll(sibling!)).body.error).toBe("seat_binding_stale");
        expect((await poll(sibling!)).body.error).toBe("seat_binding_required");
        const nextHarness = remember((await command(launcher, { spawn: "harness" })) as unknown as Fixture);
        expect((await register(launcher, nextHarness.pid)).status).toBe(200);
        const nextBridge = nextHarness.descendants[0]!;
        expect((await poll(nextBridge)).status).toBe(200);
        process.kill(launcher.pid, "SIGTERM");
        await expect.poll(() => observeNativeBirth(launcher.pid)).toBeUndefined();
        expect((await poll(nextBridge)).body.error).toBe("seat_binding_stale");
        expect(hits).toEqual(Array(5).fill("native-seat"));
      } finally {
        for (const fixture of fixtures.reverse()) {
          try {
            process.kill(fixture.pid, "SIGTERM");
          } catch {}
        }
        await rm(nonceRoot, { recursive: true, force: true });
        if (server) {
          server.closeAllConnections();
          await new Promise((resolve) => server!.close(resolve));
        }
      }
    }, 60_000);
    it("retries a dead previous launcher's stale binding until its genuine replacement registers", async () => {
      expect(await observeNativeBirth(process.pid)).toBeDefined();
      const fixtures: Fixture[] = [];
      const remember = (fixture: Fixture): Fixture => {
        fixtures.push(fixture);
        fixture.descendants.forEach(remember);
        return fixture;
      };
      const launch = async () => {
        const child = spawn(
          process.execPath,
          [new URL("./fixtures/operator-seat-binding-native.mjs", import.meta.url).pathname, "launcher"],
          {
            stdio: ["ignore", "pipe", "inherit"],
            env: { ...process.env, NODE_ENV: "test" },
          },
        );
        return remember(
          await new Promise<Fixture>((resolve, reject) => {
            let text = "";
            child.stdout!.on("data", (chunk) => {
              text += chunk;
              if (text.includes("\n")) resolve(JSON.parse(text.split("\n")[0]!));
            });
            child.once("error", reject);
            child.once("exit", (code) => {
              if (!text.includes("\n")) reject(new Error(`fixture exited ${code}`));
            });
          }),
        );
      };
      const root = await mkdtemp(join(tmpdir(), "native-stale-"));
      const nonceFile = join(root, "claim");
      await writeFile(nonceFile, nonce, { mode: 0o600 });
      let server: Server | undefined;
      try {
        const refusals: string[] = [];
        const banks: string[] = [];
        const app = new Hono();
        app.use("*", async (context, next) => {
          await next();
          if (context.res.status === 403) {
            const body = await context.res.clone().json();
            refusals.push(body.error);
          }
        });
        registerSeatRoutes({
          app,
          authenticateLane: async () => ({ lane: "operator" }),
          dependencies: {
            operatorSeatBindings: new OperatorSeatBindings({
              socket: (socket) => observeSocketProcess(socket, helper),
              birth: observeNativeBirth,
              processes: (controller, harness) => observeNativeProcesses(controller, harness),
            }),
            captain: {
              seatContext: (conversationId: string) => ({ conversationId, cwd: root }),
              laneToolBank: async (_lane: string, conversationId: string) => {
                banks.push(conversationId);
                return { lane: "operator", tools: [] };
              },
            },
          } as unknown as ClankieAppDependencies,
        });
        server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }) as Server;
        await new Promise<void>((resolve) => server!.once("listening", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const command = async (fixture: Fixture, input: unknown) => {
          const response = await fetch(`http://127.0.0.1:${fixture.port}`, {
            method: "POST",
            body: JSON.stringify(input),
          });
          return response.json();
        };
        const register = (launcher: Fixture) =>
          command(launcher, {
            url: `${origin}/v1/captain/seat-bindings`,
            method: "PUT",
            body: {
              conversationId: "native-seat",
              harnessPid: launcher.descendants[0]!.pid,
              nonceHash: seatNonceHash(nonce),
            },
          });
        const oldLauncher = await launch();
        expect((await register(oldLauncher)).status).toBe(200);
        process.kill(oldLauncher.pid, "SIGTERM");
        await expect.poll(() => observeNativeBirth(oldLauncher.pid)).toBeUndefined();
        const newLauncher = await launch();
        // Start the real MCP grandchild while the registry still holds the dead launcher.
        const connected = command(newLauncher.descendants[0]!, { spawnMcp: true, origin, file: nonceFile });
        await expect
          .poll(() => refusals.slice(0, 2), { timeout: 10_000 })
          .toEqual(["seat_binding_stale", "seat_binding_required"]);
        expect(banks).toEqual([]);
        expect((await register(newLauncher)).status).toBe(200);
        expect(await connected).toMatchObject({
          exit: 0,
          filePresent: true,
          rawPresent: false,
          tools: expect.arrayContaining(["reply"]),
        });
        expect(banks).toEqual(["native-seat"]);
      } finally {
        for (const fixture of fixtures.reverse()) {
          try {
            process.kill(fixture.pid, "SIGTERM");
          } catch {}
        }
        if (server) {
          server.closeAllConnections();
          await new Promise((resolve) => server!.close(resolve));
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
