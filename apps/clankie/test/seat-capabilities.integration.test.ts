import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { z } from "zod";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { readSeatBridges } from "../../tui/src/command/seat-delivery.ts";
import { statusCommand } from "../../tui/src/command/status.ts";
import { formatDoctorSummary } from "../../tui/src/command/doctor.ts";
import type { InstallDoctorReport } from "../../tui/src/install-doctor.ts";

const Channel = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Owned bridge did not progress");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it.each(["legacy", "modern"])(
  "negotiates the %s stdio bridge before an authenticated owner turn and exposes reconnect health",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "seat-capabilities-"));
    const bearer = `clankie_op_${"a".repeat(43)}`;
    const captainToken = `clankie_cap_${"b".repeat(43)}`;
    const captain = createCaptain(
      {
        herdrAvailable: () => false,
        presence: { listSessions: async () => [] },
        embodiment: { getLiveSession: async () => undefined },
      } as unknown as CaptainDeps,
      {
        repoRoot: root,
        stateDir: root,
        workingDirectory: root,
        settings: new SettingsStore(join(root, "settings.json")),
      },
    );
    const app = await createClankieApp({
      // This test has no connected provider accounts. Seat driver, receipts,
      // owner admission, notices and diagnostics are the production captain.
      captain: new Proxy(captain, {
        get: (target, key, receiver) =>
          key === "laneToolBank"
            ? async () => ({ lane: "operator", tools: [] })
            : Reflect.get(target, key, receiver),
      }),
      eventLogPath: join(root, "events.jsonl"),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${bearer}`
          ? { operatorId: "fixture-owner" }
          : undefined,
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === `Bearer ${captainToken}`
          ? { captainId: "fixture-captain", steerSourceLane: "api" }
          : undefined,
    });
    const http = serve({ hostname: "127.0.0.1", port: 0, fetch: app.app.fetch }) as HttpServer;
    if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
    const host = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(import.meta.dirname, "fixtures/seat-pump-stdio.ts"), host, mode],
      cwd: join(import.meta.dirname, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CLANKIE_STATE_HOME: root,
        CLANKIE_OPERATOR_TOKEN: bearer,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "owned-channel-peer", version: "1" });
    const received: z.infer<typeof Channel>[] = [];
    client.setNotificationHandler(Channel, (event) => {
      received.push(event);
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const env = {
      HOME: root,
      CLANKIE_STATE_HOME: root,
      CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
      CLANKIE_OPERATOR_TOKEN: bearer,
      CLANKIE_CAPTAIN_TOKEN: captainToken,
    };
    const journal = () => new ConversationJournal(join(root, "conversations")).read("global-default");
    try {
      await client.connect(transport as unknown as Transport);
      await until(() => captain.operatorSeatReady?.() === true);
      const bridges = await readSeatBridges({ host, env });
      expect(bridges).toMatchObject([
        {
          conversationId: "global-default",
          state: mode === "legacy" ? "stale" : "current",
          ownerOrigin: mode !== "legacy",
        },
      ]);
      const get = await captain.serveOperatorConversation({
        op: "get",
        schemaVersion: 1,
        conversationId: "global-default",
      });
      if (get.op !== "get" || !get.conversation) throw new Error("Missing owned conversation");
      const text = `owner request ${randomUUID()}`;
      const response = await fetch(`${host}/operator/v1/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          op: "send",
          schemaVersion: 1,
          turn: {
            schemaVersion: 1,
            kind: "message",
            conversationId: "global-default",
            surfaceClientId: "command-center-mobile",
            expectedRevision: get.conversation.revision,
            message: text,
          },
        }),
      });
      expect(response.status).toBe(200);
      const accepted = (await response.json()) as { result: { status: string; runId: string } };
      expect(accepted.result.status).toBe("accepted");
      await until(() => received.some((event) => event.params.content.includes(text)));
      const notification = received.find((event) => event.params.content.includes(text))!;
      expect(notification.params.meta.kind).toBe(mode === "legacy" ? "message" : "turn");
      if (mode === "legacy")
        expect(notification.params.content).toContain("operator fixture-owner, verified by the service");
      await until(() =>
        journal().some(
          (event) =>
            event.type === "turn" && event.runId === accepted.result.runId && event.phase === "completed",
        ),
      );
      expect(
        journal().filter(
          (event) =>
            event.type === "turn" && event.runId === accepted.result.runId && event.phase === "completed",
        ),
      ).toMatchObject([{ deliveryStage: "delivered" }]);
      expect(
        journal().filter((event) => event.type === "message" && event.role === "operator"),
      ).toMatchObject([
        {
          text,
          ownerOrigin: {
            surfaceClientId: "command-center-mobile",
            principal: { kind: "operator", id: "fixture-owner" },
          },
        },
      ]);
      expect(received.filter((event) => event.params.content.includes(text))).toHaveLength(1);
      expect(
        readFileSync(join(root, "delivery-receipts/head/global-default.json.delivered"), "utf8"),
      ).toContain(notification.params.meta.event_id);
      expect(stderr).not.toContain("ZodError");
      const status = await statusCommand({
        repoRoot: root,
        host,
        env,
        listProcessCommandsImpl: () => [],
        listPortOwnersImpl: () => [],
        fetchImpl: async (input, init) => {
          const url = new URL(String(input));
          return fetch(new URL(url.pathname + url.search, host), init);
        },
      });
      expect(status.seatBridges).toMatchObject([
        { conversationId: "global-default", state: mode === "legacy" ? "stale" : "current" },
      ]);
      if (mode === "legacy") {
        expect(status.nextStep).toContain("/mcp");
        const replay = await fetch(`${host}/operator/v1/dispatch`, {
          method: "POST",
          headers: { authorization: `Bearer ${captainToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            op: "replay",
            schemaVersion: 1,
            replay: {
              schemaVersion: 1,
              conversationId: "global-default",
              surfaceClientId: "command-center-mobile",
            },
          }),
        });
        expect(await replay.text()).toContain("seat needs a reconnect: /mcp");
        expect(
          formatDoctorSummary({
            captain: { ready: false, reason: "no_model" },
            doorway: { state: "ready" },
            seatBridges: { bridges },
          } as unknown as InstallDoctorReport),
        ).toContain("Stale seat bridge for global-default");
        expect(
          journal().filter(
            (event) =>
              event.type === "message" &&
              event.role === "external" &&
              event.text.includes("seat needs a reconnect: /mcp"),
          ),
        ).toHaveLength(1);
      }
      const diagnostic = readFileSync(join(root, "clankie/seat-bridges", `${transport.pid}.jsonl`), "utf8");
      expect(diagnostic).toContain('"event":"acknowledged"');
      expect(diagnostic).not.toContain('"errorName":"ZodError"');
    } finally {
      await client.close();
      await app.close();
      await captain.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

it("shows an owner reconnect notice after a taken turn loses its bridge and retains the original uncertainty", async () => {
  const root = await mkdtemp(join(tmpdir(), "seat-unacknowledged-"));
  const bearer = `clankie_op_${"a".repeat(43)}`;
  const captainToken = `clankie_cap_${"b".repeat(43)}`;
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  const app = await createClankieApp({
    captain,
    eventLogPath: join(root, "events.jsonl"),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === `Bearer ${captainToken}`
        ? { captainId: "fixture-captain", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${bearer}`
        ? { operatorId: "fixture-owner" }
        : undefined,
  });
  const http = serve({ hostname: "127.0.0.1", port: 0, fetch: app.app.fetch }) as HttpServer;
  if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
  const host = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const dispatch = async (body: { op: string; [key: string]: unknown }) => {
    const response = await fetch(`${host}/operator/v1/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.op === "send" ? bearer : captainToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const journal = () => new ConversationJournal(join(root, "conversations")).read("global-default");
  try {
    const page = fetch(`${host}/v1/seat/events?wait=1000`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    void page.catch(() => undefined); // Cleanup may close a parked owned poll after another assertion fails.
    await until(() => captain.operatorSeatReady?.() === true);
    const get = await dispatch({ op: "get", schemaVersion: 1, conversationId: "global-default" });
    const accepted = await dispatch({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "command-center-mobile",
        expectedRevision: get.conversation.revision,
        message: "This owner turn loses its bridge.",
      },
    });
    const wire = (await (await page).json()) as { events: { id: string; kind: string }[] };
    expect(wire.events).toHaveLength(1);
    expect(wire.events[0]!.kind).toBe("message");
    // No ACK and no second poll: neither diagnostic reads nor notices can settle this original.
    await until(() =>
      journal().some(
        (event) =>
          event.type === "turn" && event.runId === accepted.result.runId && event.phase === "completed",
      ),
    );
    expect(
      journal().filter(
        (event) =>
          event.type === "turn" && event.runId === accepted.result.runId && event.phase === "completed",
      ),
    ).toMatchObject([{ deliveryStage: "uncertain" }]);
    const receipts = join(root, "delivery-receipts/head/global-default.json");
    const before = readFileSync(receipts, "utf8");
    expect(before).toContain(wire.events[0]!.id);
    const replay = await dispatch({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "command-center-mobile",
      },
    });
    expect(JSON.stringify(replay)).toContain(`Owner turn ${wire.events[0]!.id} did not confirm receipt`);
    expect(JSON.stringify(replay)).toContain("seat needs a reconnect: /mcp");
    await dispatch({ op: "seat_bridges", schemaVersion: 1 });
    const unresolved = await dispatch({ op: "seat_deliveries", schemaVersion: 1 });
    expect(unresolved.unresolved).toMatchObject([{ receiptId: wire.events[0]!.id }]);
    expect(readFileSync(receipts, "utf8")).toBe(before);
  } finally {
    await app.close();
    await captain.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
