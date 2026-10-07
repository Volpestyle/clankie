import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { z } from "zod";
import { registerSeatRoutes } from "../src/app/seat-routes.ts";
import type { ClankieAppDependencies } from "../src/app/types.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

const ChannelSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});

async function until(check: () => boolean | Promise<boolean>, timeout = 1500) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start >= timeout) throw new Error("Owned receiver failed to make progress");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(fault: "outage" | "lost-response" | "refused" | "none") {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-pump-"));
  const bearer = randomUUID();
  const binding = "a".repeat(64);
  const uncertaintyPath = join(root, "original.json");
  // Leave room for real Node HTTP scheduling (a failed response can take a
  // few hundred milliseconds). Production's binding grace is 45 seconds.
  let outbox = new SeatOutbox({ uncertaintyPath, boundGraceMs: 1_000 });
  const app = new Hono();
  let faults = true;
  let ackRequests = 0;
  let polls = 0;
  const taken: string[] = [];
  // Actual HTTP faults, outside the production seat routes. Neither the SDK,
  // mailbox, receipt store nor timers are mocked.
  app.use("/v1/seat/events/:id/ack", async (context, next) => {
    ackRequests += 1;
    if (faults && fault === "outage") return context.json({ error: "owned_outage" }, 503);
    if (faults && fault === "refused") return context.json({ error: "owned_missing_receipt" }, 404);
    await next();
  });
  const { laneMcp } = registerSeatRoutes({
    app,
    authenticateLane: async (context) =>
      context.req.header("authorization") === `Bearer ${bearer}`
        ? { lane: "operator" }
        : { denial: context.json({ error: "unauthorized" }, 401) },
    // Owned service adapter: all delivery and persistence run in SeatOutbox;
    // this fixture has no model, fleet, or external tool bank.
    dependencies: {
      captain: {
        seatContext: (id?: string) =>
          id === "global-default" ? { conversationId: id, cwd: root } : undefined,
        laneToolBank: async () => ({ lane: "operator", tools: [] }),
        pollSeatEvents: async (wait: number, signal?: AbortSignal) => {
          polls += 1;
          const events = await outbox.poll(wait, signal, binding);
          taken.push(...events.map((event) => event.id));
          return events;
        },
        acknowledgeSeatEvent: async (id: string) => {
          const acknowledged = outbox.acknowledge(id, binding);
          if (faults && fault === "lost-response") {
            // Receipt is durably written before the real TCP response is lost.
            responses.get(id)?.destroy();
          }
          return acknowledged;
        },
        replySeatEvent: async (id: string, text: string) => outbox.reply(id, text, binding),
      },
    } as unknown as ClankieAppDependencies,
  });
  const responses = new Map<string, import("node:http").ServerResponse>();
  const http = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }) as HttpServer;
  http.on("request", (request, response) => {
    const match = /\/v1\/seat\/events\/([^/?]+)\/ack/u.exec(request.url ?? "");
    if (match) responses.set(match[1]!, response);
  });
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing owned HTTP port");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures/seat-pump-stdio.ts"),
      `http://127.0.0.1:${address.port}`,
    ],
    cwd: join(import.meta.dirname, ".."),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLANKIE_STATE_HOME: root,
      CLANKIE_OPERATOR_TOKEN: bearer,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "owned-transport-test-peer", version: "1" });
  const received: z.infer<typeof ChannelSchema>[] = [];
  client.setNotificationHandler(ChannelSchema, (event) => {
    received.push(event);
  });
  await client.connect(transport as unknown as Transport);
  await until(() => outbox.bound());
  const journal = async () => {
    const directory = join(root, "clankie", "seat-bridges");
    const files = await readdir(directory).catch(() => []);
    if (files.length === 0) return [];
    return (await readFile(join(directory, files[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  return {
    client,
    received,
    get outbox() {
      return outbox;
    },
    /** The service's mailbox restarts from its persisted receipts; the bridge process lives on. */
    restartOutbox: () => {
      outbox.close();
      outbox = new SeatOutbox({ uncertaintyPath, boundGraceMs: 1_000 });
    },
    taken,
    root,
    journal,
    pid: () => transport.pid,
    ackRequests: () => ackRequests,
    polls: () => polls,
    restore: () => {
      faults = false;
    },
    deliver: (content: string) =>
      outbox.deliver({
        kind: "wake",
        conversationId: "global-default",
        source: "linear",
        content,
        wantsReply: false,
        recipientBinding: binding,
      }),
    receipts: async () =>
      JSON.parse(await readFile(`${uncertaintyPath}.delivered`, "utf8")) as Record<string, unknown>,
    async close() {
      await client.close();
      outbox.close();
      await laneMcp.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
    stderr: () => stderr,
  };
}

it.each(["outage", "lost-response", "refused"] as const)(
  "keeps a real receiver polling through an ACK %s, without repeating channel delivery",
  async (fault) => {
    const f = await fixture(fault);
    try {
      const pid = f.pid();
      const first = f.deliver("signed owner comment one");
      await until(() => f.received.length === 1);
      await until(() => f.ackRequests() >= (fault === "refused" ? 1 : 2));
      const polls = f.polls();
      await until(() => f.polls() > polls);
      expect(f.outbox.bound()).toBe(true);
      expect(await first).toMatchObject({ outcome: "delivered", deliveryStage: "delivered" });
      // Keep the fault active while a subsequent owner comment arrives.
      const second = f.deliver("signed owner comment two");
      await until(() => f.received.length === 2);
      await until(() => f.polls() > polls + 1);
      expect(await second).toMatchObject({ outcome: "delivered", deliveryStage: "delivered" });
      f.restore();
      await until(() => f.received.length === 2 && f.outbox.bound());
      expect(f.pid()).toBe(pid);
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toContain("reply");
      const ids = f.received.map((event) => event.params.meta.event_id);
      expect(new Set(ids).size).toBe(2);
      expect(f.taken).toEqual(ids);
      expect(Object.keys(await f.receipts()).sort()).toEqual([...ids].sort());
      const log = await f.journal();
      expect(log.some((event) => event.event === "pump_started")).toBe(true);
      expect(
        log.filter((event) => event.event === "notification_sent").map((event) => event.eventId),
      ).toEqual(ids);
      expect(log.some((event) => event.event === "pump_stopped")).toBe(false);
      expect(
        log.every(
          (event) =>
            event.pid === pid &&
            event.conversationId === "global-default" &&
            /^[a-f0-9]{64}$/u.test(String(event.sourceHash)),
        ),
      ).toBe(true);
      expect(JSON.stringify(log)).not.toContain("signed owner comment");
      expect(JSON.stringify(log)).not.toContain(f.root);
    } finally {
      await f.close();
    }
  },
);

// 2026-10-06: a 24,249-character service handoff failed this bridge's page
// schema (ZodError at 21:21:46Z). The service had already taken it, so it was
// never shown or acknowledged, and its unresolved receipt then refused every
// later delivery to the seat as `uncertain` across service restarts.
it("keeps an oversized event parseable by a real bridge, before and after a service restart", async () => {
  const f = await fixture("none");
  try {
    const pid = f.pid();
    const wake = f.deliver("signed owner comment before the restart");
    await until(() => f.received.length === 1);
    expect(await wake).toMatchObject({ outcome: "delivered", deliveryStage: "delivered" });

    // The service's mailbox restarts from its receipts beneath the same bridge.
    f.restartOutbox();
    await until(() => f.outbox.bound(), 3_000);
    const handoff = f.deliver(`Service handoff ${"x".repeat(24_232)}`);
    await until(() => f.received.length === 2, 3_000);
    expect(await handoff).toMatchObject({ outcome: "delivered", deliveryStage: "delivered" });
    expect(f.pid()).toBe(pid);
    const clipped = f.received[1]!.params.content;
    expect(clipped.length).toBeLessThanOrEqual(16_384);
    expect(clipped).toMatch(/the last \d+ characters were not delivered/u);
    expect(f.outbox.uncertain()).toBe(false);

    const ids = f.received.map((event) => event.params.meta.event_id);
    expect(new Set(ids).size).toBe(2);
    expect(Object.keys(await f.receipts()).sort()).toEqual([...ids].sort());
    const log = await f.journal();
    expect(log.filter((event) => event.event === "pump_error")).toEqual([]);
    expect(log.filter((event) => event.event === "notification_sent").map((event) => event.eventId)).toEqual(
      ids,
    );
  } finally {
    await f.close();
  }
});
