import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import { SeatLinkInterruptedError, SeatOutbox } from "../src/captain/seat-outbox.ts";
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

/**
 * One service process's seat door: the production seat routes over a real
 * mailbox. `close()` does what the captain's close does to its outboxes, after
 * which every seat call throws the shutdown reason.
 */
function service(root: string, bearer: string, binding: string, port: number) {
  const outbox = new SeatOutbox({ uncertaintyPath: join(root, "receipts.json"), boundGraceMs: 1_000 });
  const statuses: number[] = [];
  let closed = false;
  const app = new Hono();
  app.use(async (context, next) => {
    await next();
    statuses.push(context.res.status);
  });
  const { laneMcp } = registerSeatRoutes({
    app,
    authenticateLane: async (context) =>
      context.req.header("authorization") === `Bearer ${bearer}`
        ? { lane: "operator" }
        : { denial: context.json({ error: "unauthorized" }, 401) },
    dependencies: {
      captain: {
        seatContext: (id?: string) =>
          id === "global-default" ? { conversationId: id, cwd: root } : undefined,
        laneToolBank: async () => ({ lane: "operator", tools: [] }),
        pollSeatEvents: async (wait: number, signal?: AbortSignal) => {
          if (closed) throw new SeatLinkInterruptedError();
          return await outbox.poll(wait, signal, binding);
        },
        acknowledgeSeatEvent: async (id: string) => {
          if (closed) throw new SeatLinkInterruptedError();
          return outbox.acknowledge(id, binding);
        },
        replySeatEvent: async (id: string, text: string) => outbox.reply(id, text, binding),
      },
    } as unknown as ClankieAppDependencies,
  });
  const http = serve({ hostname: "127.0.0.1", port, fetch: app.fetch }) as HttpServer;
  return {
    http,
    outbox,
    statuses,
    laneMcp,
    listening: new Promise<void>((resolve, reject) => {
      http.once("listening", resolve);
      http.once("error", reject);
    }),
    closeCaptain() {
      closed = true;
      outbox.close();
    },
  };
}

// 2026-10-07: after an update the old service settled its shutdown but kept
// answering the operator seat's bridge an empty 200 over a keep-alive socket
// for 50 minutes. The replacement never saw its seat bound and routed every
// wake to the Pi lane until the old process was killed by hand.
it("moves a live seat bridge from a shutting-down service to its replacement on the same port", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-shutdown-"));
  const bearer = randomUUID();
  const binding = "b".repeat(64);
  const old = service(root, bearer, binding, 0);
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
  let closeOldConnections: (() => void) | undefined;
  try {
    await client.connect(transport as unknown as Transport);
    await until(() => old.outbox.bound());
    const pid = transport.pid;

    // The old captain closes while its server still accepts the bridge.
    old.closeCaptain();
    await until(() => old.statuses.includes(503));

    // Shutdown drains the old server; the update starts its replacement.
    closeOldConnections = drainHttpServer(old.http);
    replacement = service(root, bearer, binding, address.port);
    await replacement.listening;
    await until(() => replacement!.outbox.bound());

    const wake = replacement.outbox.deliver({
      kind: "wake",
      conversationId: "global-default",
      source: "linear",
      content: "delivered by the live service",
      wantsReply: false,
      recipientBinding: binding,
    });
    await until(() => received.length === 1);
    expect(await wake).toMatchObject({ outcome: "delivered", deliveryStage: "delivered" });
    expect(received[0]!.params.content).toBe("delivered by the live service");
    expect(transport.pid).toBe(pid);
  } finally {
    await client.close();
    closeOldConnections?.();
    for (const instance of [old, replacement]) {
      if (instance === undefined) continue;
      instance.outbox.close();
      await instance.laneMcp.close();
      instance.http.closeAllConnections();
      await new Promise<void>((resolve) => instance.http.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
