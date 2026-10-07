import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SettingsStore } from "@clankie/settings";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { z } from "zod";
import { registerSeatRoutes } from "../src/app/seat-routes.ts";
import type { ClankieAppDependencies } from "../src/app/types.ts";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { drainHttpServer } from "../src/http-drain.ts";

const ChannelSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});

async function until(check: () => boolean, timeout = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start >= timeout) throw new Error("Seat bridge failed to make progress");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function captainAt(root: string) {
  return createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
}

/** One service process: the production seat routes over a real captain. */
function service(captain: ReturnType<typeof captainAt>, bearer: string, port: number) {
  const app = new Hono();
  const { laneMcp } = registerSeatRoutes({
    app,
    authenticateLane: async (context) =>
      context.req.header("authorization") === `Bearer ${bearer}`
        ? { lane: "operator" }
        : { denial: context.json({ error: "unauthorized" }, 401) },
    dependencies: {
      // The seat's lane tools need connected accounts this test does not hold;
      // everything the outbox, driver fence and restart decide is the real captain.
      captain: new Proxy(captain, {
        get: (target, key, receiver) =>
          key === "laneToolBank"
            ? async () => ({ lane: "operator", tools: [] })
            : (Reflect.get(target, key, receiver) as unknown),
      }),
    } as unknown as ClankieAppDependencies,
  });
  const http = serve({ hostname: "127.0.0.1", port, fetch: app.fetch }) as HttpServer;
  return {
    http,
    laneMcp,
    listening: new Promise<void>((resolve, reject) => {
      http.once("listening", resolve);
      http.once("error", reject);
    }),
  };
}

const send = (captain: ReturnType<typeof captainAt>, message: string, expectedRevision: number) =>
  captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "send",
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "app",
      expectedRevision,
      message,
    },
  });

// 2026-10-07: after `clankie update` restarted the service, a wake arrived in
// the seconds before the live seat bridge's next poll. The new process had
// never seen the seat poll, ran the conversation on pi beside the still-active
// native turn for five minutes, and parked every seat poll behind that run.
it("a live seat bridge keeps its conversation across a service restart; no service turn runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-reconnect-"));
  const bearer = randomUUID();
  let first: ReturnType<typeof captainAt> | undefined = captainAt(root);
  const old = service(first, bearer, 0);
  await old.listening;
  const address = old.http.address();
  if (!address || typeof address === "string") throw new Error("Missing owned HTTP port");
  const host = `http://127.0.0.1:${address.port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(import.meta.dirname, "fixtures/seat-pump-stdio.ts"), host],
    cwd: join(import.meta.dirname, ".."),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLANKIE_STATE_HOME: root,
      CLANKIE_OPERATOR_TOKEN: bearer,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "owned-transport-test-peer", version: "1" });
  const received: z.infer<typeof ChannelSchema>[] = [];
  client.setNotificationHandler(ChannelSchema, (event) => {
    received.push(event);
  });
  let replacement: ReturnType<typeof service> | undefined;
  let second: ReturnType<typeof captainAt> | undefined;
  let closeOldConnections: (() => void) | undefined;
  try {
    await client.connect(transport as unknown as Transport);
    await until(() => first!.operatorSeatReady?.() === true);
    const pid = transport.pid;

    // The update stops the old service while the bridge is parked mid-poll.
    await first.close();
    first = undefined;
    closeOldConnections = drainHttpServer(old.http);
    await old.laneMcp.close();
    closeOldConnections();
    await new Promise<void>((resolve) => old.http.close(() => resolve()));

    // The replacement boots and work for the seat arrives before it listens,
    // so the bridge cannot have polled it yet.
    second = captainAt(root);
    expect(second.operatorSeatReady?.()).toBe(true);
    const startedAt = Date.now();
    const accepted = send(second, "arrived during the restart", 0);

    replacement = service(second, bearer, address.port);
    await replacement.listening;
    await until(() => received.length === 1, 10_000);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(received[0]!.params.content).toContain("arrived during the restart");
    expect(await accepted).toMatchObject({
      op: "send",
      result: { status: "accepted" },
    });
    expect(transport.pid).toBe(pid);

    // The bridge journaled why each poll failed during the restart, without messages.
    const journal = readFileSync(join(root, "clankie", "seat-bridges", `${String(pid)}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failures = journal.filter((entry) => entry.event === "pump_error" && entry.stage === "poll");
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.elapsedMs).toEqual(expect.any(Number));
      expect(failure.httpStatus === 503 || failure.causeCode !== undefined).toBe(true);
      expect(failure).not.toHaveProperty("message");
    }

    // The seat drove the turn: no service-lane output or failure was journaled.
    const events = new ConversationJournal(join(root, "conversations")).read("global-default");
    expect(events.filter((event) => event.type === "turn" && event.phase === "failed")).toEqual([]);
    expect(events.filter((event) => event.type === "tool")).toEqual([]);
    expect(
      events.filter(
        (event) => event.type === "message" && (event.role === "captain" || event.role === "agent"),
      ),
    ).toEqual([]);
  } finally {
    await client.close();
    closeOldConnections?.();
    await first?.close();
    await second?.close();
    await old.laneMcp.close();
    if (replacement !== undefined) {
      await replacement.laneMcp.close();
      replacement.http.closeAllConnections();
      await new Promise<void>((resolve) => replacement!.http.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("a seat last seen long before the restart is gone: the service keeps the conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-gone-"));
  const directory = join(root, "delivery-receipts", "head");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "global-default.json.presence"),
    JSON.stringify({ schemaVersion: 1, lastPollAt: Date.now() - 10 * 60_000 }),
  );
  const captain = captainAt(root);
  try {
    expect(captain.operatorSeatReady?.()).toBe(false);
  } finally {
    await captain.close();
    await rm(root, { recursive: true, force: true });
  }
});
