import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { processIdentity } from "@clankie/fleet-resources";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { registerSeatRoutes } from "../src/app/seat-routes.ts";
import type { ClankieAppDependencies } from "../src/app/types.ts";
import { OperatorSeatBindings, seatNonceHash } from "../src/operator-seat-bindings.ts";
import { OperatorSeatMigrations } from "../src/operator-seat-migrations.ts";
import { SeatCallReceipts } from "../src/seat-call-receipts.ts";
import {
  fleetProcessHelper,
  observeNativeBirth,
  observeNativeProcesses,
  observeSocketProcess,
} from "../src/local-fleet-process.ts";

interface Native {
  pid: number;
  port: number;
  descendants: Native[];
}

test("an HTTP migration retains original receipts and its durable hold until exact native exit and a bound successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "seat-migration-"));
  const helper = fleetProcessHelper();
  const children: Native[] = [];
  const births = new Map<number, string>();
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  for (const name of [
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
  ]) {
    env[name] = join(root, name);
    await mkdir(env[name]!, { recursive: true, mode: 0o700 });
  }
  const launch = async () => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "fixtures/operator-seat-binding-native.mjs"), "launcher"],
      { stdio: ["ignore", "pipe", "inherit"], env },
    );
    const result = await new Promise<Native>((resolve, reject) => {
      let text = "";
      child.stdout!.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) resolve(JSON.parse(text.split("\n")[0]!));
      });
      child.once("error", reject);
      child.once("exit", () => {
        if (!text.includes("\n")) reject(Error("Native fixture exited before ready"));
      });
    });
    const remember = (row: Native) => {
      children.push(row);
      row.descendants.forEach(remember);
    };
    remember(result);
    for (const row of children) {
      if (births.has(row.pid)) continue;
      const birth = await processIdentity(row.pid);
      if (!birth) throw Error("Owned fixture disappeared before recording its lifetime");
      births.set(row.pid, birth.startTime);
    }
    return result;
  };
  const stop = async (row: Native) => {
    if ((await processIdentity(row.pid))?.startTime === births.get(row.pid)) process.kill(row.pid, "SIGTERM");
  };
  const command = async (native: Native, input: unknown) =>
    (await fetch(`http://127.0.0.1:${native.port}`, { method: "POST", body: JSON.stringify(input) })).json();
  const migrations = new OperatorSeatMigrations(join(root, "migrations", "journal.json"));
  const receipts = new SeatCallReceipts(join(root, "receipts.json"));
  const conversationId = "migration-proof",
    sessionId = randomUUID(),
    id = randomUUID(),
    original = randomUUID();
  let native = await launch();
  const proof = async () => {
    const process = await processIdentity(native.pid);
    if (!process) throw Error("Native launcher disappeared");
    return { pid: process.pid, startTime: process.startTime };
  };
  const processes: Array<{ pid: number; startTime: string }> = [];
  for (const row of children) {
    const process = await processIdentity(row.pid);
    if (!process) throw Error("Native child disappeared");
    processes.push({ pid: process.pid, startTime: process.startTime });
  }
  await mkdir(join(root, "profile"), { mode: 0o700 });
  let present = true;
  let idle = true;
  let ready = true;
  let forceUnbound = false;
  const registry = new OperatorSeatBindings(
    {
      socket: (socket) => observeSocketProcess(socket, helper),
      birth: observeNativeBirth,
      processes: observeNativeProcesses,
    },
    "observe",
  );
  const recovery = {
    sessionId,
    cwd: root,
    profile: join(root, "profile"),
    recovery: "exact fixture profile",
  };
  const app = new Hono();
  const { laneMcp } = registerSeatRoutes({
    app,
    authenticateLane: async () => ({ lane: "operator" }),
    dependencies: {
      operatorSeatBindings: registry,
      operatorSeatMigrations: migrations,
      seatCallReceiptPath: join(root, "receipts.json"),
      operatorSeatInventory: async () => ({
        complete: true,
        ready: !present,
        seats: present
          ? [
              {
                ...(await proof()),
                command: "claude",
                conversationId,
                sessionId,
                processes,
                bound:
                  !forceUnbound &&
                  (await registry.registeredLauncher(native.pid, (await proof()).startTime)) ===
                    conversationId,
              },
            ]
          : [],
      }),
      captain: {
        operatorSeatRecovery: async () => recovery,
        operatorSeatMigrationIdle: () => idle,
        operatorSeatReady: () => ready,
        seatContext: () => ({ conversationId, cwd: root }),
        pollSeatEvents: async () => [],
      },
    } as unknown as ClankieAppDependencies,
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (input: unknown) => {
    const response = await fetch(`${origin}/v1/captain/seat-migrations`, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
    return { status: response.status, body: await response.json() };
  };
  const claim = { action: "claim", id, conversationId, sessionId, cwd: root, profile: recovery.profile };
  try {
    idle = false;
    expect((await call({ action: "prepare", id, conversationId })).status).toBe(409);
    expect(migrations.pending()).toEqual([]); // Every identity condition is valid; idle alone refuses.
    idle = true;
    const prepared = await call({ action: "prepare", id, conversationId });
    expect(prepared.status).toBe(200);
    expect(prepared.body.pendingReceiptIds).toEqual([]);
    expect(new OperatorSeatMigrations(join(root, "migrations", "journal.json")).held(conversationId)).toBe(
      true,
    );
    expect((await call(claim)).status).toBe(409);
    receipts.begin(original, "hire_agent", { task: "original only" }, "operator", conversationId);
    expect((await call({ action: "status", id })).body.pendingReceiptIds).toEqual([original]);
    receipts.settle(original, { content: [], structuredContent: { outcome: "uncertain" } });
    expect((await call({ action: "status", id })).body.pendingReceiptIds).toEqual([original]);
    expect((await call(claim)).status).toBe(409);
    expect((await call(claim)).status).toBe(409); // Old native lifetime still live.
    for (const row of [...children].reverse()) await stop(row);
    for (const row of children) await expect.poll(() => observeNativeBirth(row.pid)).toBeUndefined();
    present = false;
    const paused = await (await fetch(`${origin}/v1/captain/seat-bindings`)).json();
    expect(paused.inventory.ready).toBe(false); // No launchers does not erase a deliberate pause.
    expect(paused.inventory.migrations).toHaveLength(1);
    expect((await call(claim)).status).toBe(409); // Exit proven; only the original receipt blocks.
    expect(migrations.get(id).state).toBe("held");
    receipts.settle(original, { content: [{ type: "text", text: "Original result; no second hire" }] });
    for (const changed of [
      { sessionId: randomUUID() },
      { conversationId: "another-conversation" },
      { cwd: join(root, "other") },
      { profile: join(root, "other") },
    ]) {
      expect((await call({ ...claim, ...changed })).status).toBe(409);
      expect(migrations.get(id).state).toBe("held");
    }
    native = await launch();
    present = true;
    const nonce = "e".repeat(64),
      harness = native.descendants[0]!;
    expect(
      (
        await command(native, {
          url: `${origin}/v1/captain/seat-bindings`,
          method: "PUT",
          body: { conversationId, harnessPid: harness.pid, nonceHash: seatNonceHash(nonce) },
        })
      ).status,
    ).toBe(200);
    const current = await proof();
    expect(await registry.registeredLauncher(current.pid, current.startTime, false)).toBe(conversationId);
    expect(await registry.registeredLauncher(current.pid, current.startTime)).toBeUndefined();
    expect(
      (
        await command(harness.descendants[0]!, {
          url: `${origin}/v1/seat/events?conversationId=${conversationId}&wait=0`,
          headers: { "x-clankie-bridge-claim": nonce },
        })
      ).status,
    ).toBe(200);
    expect(await registry.registeredLauncher(current.pid, current.startTime)).toBe(conversationId);
    // Exact bound successor and readiness are valid; only the absent claim blocks completion.
    expect((await call({ action: "complete", id })).status).toBe(409);
    expect((await call(claim)).status).toBe(200);
    expect(new OperatorSeatMigrations(join(root, "migrations", "journal.json")).held(conversationId)).toBe(
      true,
    );
    expect((await call(claim)).status).toBe(409); // One launch claim, including after uncertainty.
    forceUnbound = true;
    expect((await call({ action: "complete", id })).status).toBe(409);
    expect(migrations.get(id).state).toBe("resuming");
    forceUnbound = false;
    ready = false;
    expect((await call({ action: "complete", id })).status).toBe(409);
    ready = true;
    const late = randomUUID();
    receipts.begin(late, "message_seat", { message: "late original" }, "operator", conversationId);
    expect((await call({ action: "complete", id })).status).toBe(409);
    receipts.settle(late, { content: [{ type: "text", text: "Original settled result" }] });
    expect((await call({ action: "complete", id })).status).toBe(200);
    expect(new OperatorSeatMigrations(join(root, "migrations", "journal.json")).held(conversationId)).toBe(
      false,
    );
    expect(receipts.pending(conversationId)).toEqual([]);
  } finally {
    for (const row of [...children].reverse()) {
      try {
        await stop(row);
      } catch {}
    }
    await laneMcp.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
