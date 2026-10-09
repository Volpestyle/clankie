import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import { WorkerReportPageSchema } from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { createWorkerReports, type WorkerReportsContext } from "../src/captain/captain-worker-reports.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { runAgentsCommand } from "../../tui/src/command/agents.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(count: number) {
  const root = await mkdtemp(join(tmpdir(), "worker-report-cli-"));
  const path = join(root, "conversations");
  let store = new ConversationStore(path, async () => {
    throw new Error("No model calls in report acknowledgment");
  });
  const receipts = new InboundSeatReceipts(join(root, "receipts.json"), store);
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    ids.push(id);
    expect(
      receipts.accept(
        "w3Z:pCass",
        { id, binding: "a".repeat(64) },
        `Retained report ${index}`,
        `Worker output: ${index}`,
        "global-default",
        async (_id, _message, _publish, context) => {
          context.deliveryReceipt?.("unavailable");
        },
        { source: "adoption", conversationId: "global-default" },
        { kind: "conversation", owner: { conversationId: "global-default" } },
      ),
    ).toMatchObject({ received: true });
  }
  await store.close();
  const metaPath = join(path, "global-default/meta.json");
  const metadata = JSON.parse(await readFile(metaPath, "utf8"));
  for (const id of ids) {
    delete metadata.inboundAcceptances[id].reportDelivery;
    delete metadata.inboundAcceptances[id].acceptedAt;
  }
  await writeFile(metaPath, JSON.stringify(metadata));
  store = new ConversationStore(path, async () => {
    throw new Error("Acknowledgment must never replay a report");
  });
  const reports = createWorkerReports({
    conversations: store,
    onChange: () => undefined,
  } as unknown as WorkerReportsContext);
  const serve = createOperatorService({
    conversations: store,
    personas: { ready: async () => undefined },
    deps: {},
    reportSummaries: reports.reportSummaries,
    refreshFleet: async () => [],
    validateConversationOwner: (owner: { conversationId: string }) =>
      store.conversation(owner.conversationId) !== undefined,
  } as unknown as CreateOperatorServiceContext);
  const service = await createClankieApp({
    captain: createStubCaptain({ serveOperatorConversation: serve }),
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer captain"
        ? { captainId: "captain", steerSourceLane: "api" }
        : undefined,
  });
  const server = createServer(async (request, response) => {
    const result = await service.app.request(request.url!, {
      method: request.method ?? "POST",
      headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
      body: await text(request),
    });
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(await result.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const env = {
    CLANKIE_OPERATOR_TOKEN: "owner",
    CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
  };
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, service, ids, env, root, serve };
}

it.each([20, 100])("acknowledges %i exact IDs returned by a real CLI HTTP page", async (count) => {
  const f = await fixture(count);
  const page = WorkerReportPageSchema.parse(
    await runAgentsCommand(["reports", "--conversation", "global-default", "--limit", String(count)], {
      env: f.env,
    }),
  );
  expect(page.items).toHaveLength(count);
  expect(
    await runAgentsCommand(["reports", "ack", ...page.ackDeliveryIds, "--conversation", "global-default"], {
      env: f.env,
    }),
  ).toEqual({ conversationId: "global-default", acknowledged: count });
  expect(f.store.inboundReports()).toEqual([]);
});

it("accepts the returned JSON page verbatim and preserves conversation binding", async () => {
  const f = await fixture(1);
  const page = await runAgentsCommand(["reports", "--conversation", "global-default"], { env: f.env });
  await expect(
    runAgentsCommand(["reports", "ack", "--json-stdin", "--conversation", "other"], {
      env: f.env,
      stdin: Readable.from([JSON.stringify(page)]),
    }),
  ).rejects.toThrow("different conversation");
  expect(
    await runAgentsCommand(
      [
        "reports",
        "ack",
        "--json-stdin",
        "--conversation",
        "global-default",
        "--receipt",
        JSON.stringify({
          summary: "Follow-up recorded.",
          links: ["https://linear.app/vuhlp/issue/VUH-1898"],
        }),
      ],
      {
        env: f.env,
        stdin: Readable.from([JSON.stringify(page)]),
      },
    ),
  ).toEqual({ conversationId: "global-default", acknowledged: 1 });
  const receipt = f.store
    .senderReportEvents("w3Z:pCass", "a".repeat(64))
    .find((event) => event.id.endsWith(":acknowledged"));
  expect(receipt?.content).toContain("Follow-up recorded.");
  expect(receipt?.content).toContain("https://linear.app/vuhlp/issue/VUH-1898");
});

it("retires 165 selected migrated reports only as the operator, while preserving a fresh unread report", async () => {
  const f = await fixture(165);
  const fresh = randomUUID();
  new InboundSeatReceipts(join(f.root, "fresh-receipts.json"), f.store).accept(
    "w3Z:pFresh",
    { id: fresh, binding: "b".repeat(64) },
    "Fresh unread report",
    "Fresh unread report",
    "global-default",
    async (_id, _message, _publish, context) => {
      context.deliveryReceipt?.("unavailable");
    },
    { source: "adoption", conversationId: "global-default" },
    { kind: "conversation", owner: { conversationId: "global-default" } },
  );
  const request = {
    op: "acknowledge_worker_report_history",
    schemaVersion: 1,
    conversationId: "global-default",
    deliveryIds: f.ids,
  };
  const denied = await f.service.app.request("/operator/v1/dispatch", {
    method: "POST",
    headers: { authorization: "Bearer captain", "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  expect(denied.status).toBe(403);
  expect(f.store.inboundReports()).toHaveLength(166);
  expect(
    await runAgentsCommand(["reports", "ack-history", ...f.ids, "--conversation", "global-default"], {
      env: f.env,
    }),
  ).toEqual({ conversationId: "global-default", acknowledged: 165 });
  expect(f.store.inboundReports().map((report) => report.deliveryId)).toEqual([fresh]);
  const roster = await f.serve({ op: "roster", schemaVersion: 1 });
  expect(roster.op === "roster" && roster.workerReports?.map((report) => report.deliveryId)).toEqual([fresh]);
  await expect(
    runAgentsCommand(["reports", "ack-history", randomUUID(), "--conversation", "global-default"], {
      env: f.env,
    }),
  ).rejects.toThrow("must belong to this conversation");
});

it("clears the roster history warning and preserves acknowledgments after restart", async () => {
  const f = await fixture(165);
  const before = await f.serve({ op: "roster", schemaVersion: 1 });
  expect(before.op === "roster" && before.workerReports).toHaveLength(165);
  await runAgentsCommand(["reports", "ack-history", ...f.ids, "--conversation", "global-default"], {
    env: f.env,
  });
  const after = await f.serve({ op: "roster", schemaVersion: 1 });
  expect(after.op === "roster" && after.workerReports).toEqual([]);
  await f.store.close();
  const reopened = new ConversationStore(join(f.root, "conversations"), async () => {
    throw new Error("No report replay");
  });
  try {
    expect(reopened.inboundReports()).toEqual([]);
    expect(reopened.inboundReports(undefined, { includeRead: true })).toHaveLength(165);
  } finally {
    await reopened.close();
  }
});
