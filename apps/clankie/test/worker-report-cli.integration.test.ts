import { readPersistedConversation } from "./support/persisted-conversation.ts";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import {
  WorkerReportPageSchema,
  WorkerReportSummarySchema,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";
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

async function fixture(
  count: number,
  options: {
    reportText?: (index: number) => string;
    directAcceptance?: boolean;
    observedSeats?: WorkerReportsContext["observedSeats"];
  } = {},
) {
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
    // These cases read a restored historical inbox. Produce its legacy record
    // shape once; bulk fixture construction need not fsync hundreds of live admissions,
    // which cost about 90 ms each and timed out landing gates under load (VUH-2929).
    if (options.directAcceptance && index > 0) continue;
    const reportText = options.reportText?.(index) ?? `Retained report ${index}`;
    // The large inbox proof needs retained acceptance, not each sender's separate delivery fence.
    if (options.directAcceptance) {
      expect(
        store.submitInbound(
          `Worker output: ${index}`,
          {
            deliveryId: id,
            binding: "a".repeat(64),
            paneId: "w3Z:pCass",
            text: reportText,
            fingerprint: deliveryFingerprint(reportText),
            workerReportRouting: { source: "adoption", conversationId: "global-default" },
            recipient: { kind: "conversation", owner: { conversationId: "global-default" } },
          },
          "global-default",
          async (_id, _message, _publish, context) => {
            context.deliveryReceipt?.("unavailable");
          },
        ),
      ).toMatchObject({ status: "accepted" });
      continue;
    }
    expect(
      receipts.accept(
        "w3Z:pCass",
        { id, binding: "a".repeat(64) },
        reportText,
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
  const metadata = readPersistedConversation(metaPath);
  if (options.directAcceptance && ids.length > 0) {
    const produced = metadata.inboundAcceptances[ids[0]!];
    for (const [index, id] of ids.entries()) {
      const reportText = options.reportText?.(index) ?? `Retained report ${index}`;
      metadata.inboundAcceptances[id] = {
        ...produced,
        deliveryId: id,
        runId: index === 0 ? produced.runId : `run-${randomUUID()}`,
        text: reportText,
        message: `Worker output: ${index}`,
        fingerprint: deliveryFingerprint(reportText),
      };
    }
  }
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
    observedSeats: options.observedSeats,
  } as unknown as WorkerReportsContext);
  const serve = createOperatorService({
    conversations: store,
    shutdown: new AbortController(),
    personas: { ready: async () => undefined },
    deps: {},
    reportSummaries: reports.reportSummaries,
    refreshFleet: async () => [],
    rosterSeats: async () => ({ seats: [] }),
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
    await service.close();
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { store, service, ids, env, root, serve };
}

it("joins report metadata to the already observed census and drops seat IDs when the pane leaves it", async () => {
  let observed = [{ paneId: "w3Z:pCass", seatId: "term_65db244fd1e1847" }];
  const f = await fixture(1, { observedSeats: () => observed });
  const roster = async () => {
    const response = await fetch(`${f.env.CLANKIE_CONTROL_PLANE_URL}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer captain", "content-type": "application/json" },
      body: JSON.stringify({ op: "roster", schemaVersion: 1 }),
    });
    expect(response.status).toBe(200);
    const result = OperatorConversationServiceResultSchema.parse(await response.json());
    if (result.op !== "roster") throw new Error("Expected roster response");
    return result.workerReports!;
  };
  const joined = await roster();
  expect(joined).toHaveLength(1);
  expect(joined[0]).toMatchObject({ deliveryId: f.ids[0], paneId: "w3Z:pCass", seatId: observed[0]!.seatId });
  observed = [{ paneId: "another-pane", seatId: "another-seat" }];
  const missing = await roster();
  expect(missing[0]).not.toHaveProperty("seatId");
  expect(missing).toEqual(joined.map(({ seatId: _seatId, ...report }) => report));
  observed = [];
  expect(await roster()).toEqual(missing);
  expect(WorkerReportSummarySchema.safeParse({ ...missing[0], seatId: 42 }).success).toBe(false);
});

it("projects a large restored inbox without offering or changing retained payloads, preserving admission and acknowledgment fences", async () => {
  const f = await fixture(585, {
    directAcceptance: true,
    reportText: (index) => `Original retained report ${index}: ${"retained payload ".repeat(512)}`,
  });
  const metaPath = join(f.root, "conversations", "global-default", "meta.json");
  const before = await readFile(metaPath, "utf8");
  const summaries = f.store.inboundReportSummaries("global-default");
  expect(summaries).toHaveLength(585);
  for (const summary of summaries) WorkerReportSummarySchema.parse(summary);
  const selected = summaries.at(-1)!;
  const sibling = summaries.at(-2)!;
  expect(Object.keys(selected).sort()).toEqual(
    ["deliveryId", "conversationId", "paneId", "acceptedAt", "state", "stage"].sort(),
  );
  expect(
    f.store.inboundReportSummaries(undefined, {
      sender: { paneId: selected.paneId, binding: "a".repeat(64) },
    }),
  ).toEqual(summaries);
  expect(
    f.store.inboundReportSummaries(undefined, {
      sender: { paneId: selected.paneId, binding: "b".repeat(64) },
    }),
  ).toEqual([]);
  expect(
    f.store.inboundReportSummaries(undefined, { acceptedAfterMs: Date.parse(selected.acceptedAt) }),
  ).toEqual([]);
  expect(await readFile(metaPath, "utf8")).toBe(before);
  const corruptRoot = join(f.root, "corrupt-history");
  const corruptPath = join(corruptRoot, "invalid-report-history", "meta.json");
  const corrupt = readPersistedConversation(metaPath);
  corrupt.conversationId = "invalid-report-history";
  corrupt.inboundAcceptances[selected.deliveryId].text = {};
  await mkdir(join(corruptRoot, "invalid-report-history"), { recursive: true });
  const corruptBytes = JSON.stringify(corrupt);
  await writeFile(corruptPath, corruptBytes);
  const reopened = new ConversationStore(corruptRoot, async () => {
    throw new Error("Malformed retained input must never run");
  });
  try {
    expect(reopened.inboundReportSummaries()).toEqual([]);
    expect(reopened.conversation("invalid-report-history")).toBeUndefined();
    expect(await readFile(corruptPath, "utf8")).toBe(corruptBytes);
  } finally {
    await reopened.close();
  }
  expect(f.store.inboundAcceptance(selected.deliveryId)?.reportDelivery?.offeredAt).toBeUndefined();
  await expect(
    runAgentsCommand(["reports", "ack", selected.deliveryId, "--conversation", "global-default"], {
      env: f.env,
    }),
  ).rejects.toThrow("Only fully offered worker reports may be acknowledged");
  expect(() =>
    f.store.submitInbound("invalid report", {
      deliveryId: randomUUID(),
      binding: "a".repeat(64),
      paneId: selected.paneId,
      fingerprint: "invalid",
      text: {} as unknown as string,
    }),
  ).toThrow();
  expect(await readFile(metaPath, "utf8")).toBe(before);
  const page = WorkerReportPageSchema.parse(
    await runAgentsCommand(
      ["reports", "--conversation", "global-default", "--delivery-ids", selected.deliveryId],
      { env: f.env },
    ),
  );
  expect(page.items).toEqual([
    expect.objectContaining({
      deliveryId: selected.deliveryId,
      text: f.store.inboundAcceptance(selected.deliveryId)!.text,
    }),
  ]);
  expect(f.store.inboundAcceptance(sibling.deliveryId)?.reportDelivery?.offeredAt).toBeUndefined();
  expect(
    await runAgentsCommand(["reports", "ack", selected.deliveryId, "--conversation", "global-default"], {
      env: f.env,
    }),
  ).toMatchObject({ acknowledged: 1 });
  expect(f.store.inboundReportSummaries()).toHaveLength(584);
  expect(f.store.inboundReportSummaries(undefined, { includeRead: true })).toHaveLength(585);
}, 60_000);

it.each([20, 100])("acknowledges %i exact IDs returned by a real CLI HTTP page", async (count) => {
  const f = await fixture(count, { directAcceptance: true });
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
  ).toEqual({
    conversationId: "global-default",
    acknowledged: count,
    unanswered: page.ackDeliveryIds,
    instruction: expect.stringContaining("still open"),
  });
  expect(f.store.inboundReports()).toEqual([]);
});

it("reads and explicitly acknowledges the newest selected report behind 669 unread reports (VUH-2188)", async () => {
  const f = await fixture(669, { directAcceptance: true });
  const unread = f.store.inboundReports("global-default");
  const newest = unread.at(-1)!;
  const sibling = unread.at(-2)!;
  const page = WorkerReportPageSchema.parse(
    await runAgentsCommand(
      ["reports", "--conversation", "global-default", "--delivery-ids", newest.deliveryId, "--limit", "1"],
      { env: f.env },
    ),
  );
  expect(page.unreadCount).toBe(669);
  expect(page.items).toEqual([expect.objectContaining({ deliveryId: newest.deliveryId, text: newest.text })]);
  expect(page.ackDeliveryIds).toEqual([newest.deliveryId]);
  expect(f.store.inboundReports("global-default")).toHaveLength(669);
  expect(f.store.inboundAcceptance(newest.deliveryId)?.reportDelivery?.offeredAt).toBeDefined();
  expect(f.store.inboundAcceptance(sibling.deliveryId)?.reportDelivery?.offeredAt).toBeUndefined();
  await expect(
    runAgentsCommand(["reports", "ack", sibling.deliveryId, "--conversation", "global-default"], {
      env: f.env,
    }),
  ).rejects.toThrow("Only fully offered worker reports may be acknowledged");
  expect(f.store.inboundReports("global-default")).toHaveLength(669);

  expect(
    await runAgentsCommand(["reports", "ack", newest.deliveryId, "--conversation", "global-default"], {
      env: f.env,
    }),
  ).toMatchObject({ conversationId: "global-default", acknowledged: 1 });
  expect(f.store.inboundAcceptance(newest.deliveryId)?.reportDelivery?.state).toBe("read");
  expect(f.store.inboundReports("global-default")).toHaveLength(668);
  expect(
    await runAgentsCommand(
      ["reports", "--conversation", "global-default", "--delivery-ids", newest.deliveryId],
      { env: f.env },
    ),
  ).toEqual({ conversationId: "global-default", unreadCount: 668, items: [], ackDeliveryIds: [] });

  const oldestPage = WorkerReportPageSchema.parse(
    await runAgentsCommand(["reports", "--conversation", "global-default"], { env: f.env }),
  );
  expect(oldestPage.items.map((item) => item.deliveryId)).toEqual(
    unread.slice(0, 20).map((report) => report.deliveryId),
  );
  expect(oldestPage.unreadCount).toBe(668);
  expect(f.store.inboundReports("global-default")).toHaveLength(668);
});

it("never offers foreign or unknown IDs selected through the CLI HTTP boundary (VUH-2188)", async () => {
  const f = await fixture(2);
  const created = await f.store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "Other private lead",
  });
  if (created.op !== "create") throw new Error("Foreign conversation was not created");
  const foreignConversation = created.conversation.conversationId;
  const foreign = randomUUID();
  const privateText = "Private report for the other lead only";
  expect(
    new InboundSeatReceipts(join(f.root, "foreign-receipts.json"), f.store).accept(
      "w3Z:pForeign",
      { id: foreign, binding: "c".repeat(64) },
      privateText,
      privateText,
      foreignConversation,
      async (_id, _message, _publish, context) => {
        context.deliveryReceipt?.("unavailable");
      },
      { source: "adoption", conversationId: foreignConversation },
      { kind: "conversation", owner: { conversationId: foreignConversation } },
    ),
  ).toMatchObject({ received: true });
  const unknown = randomUUID();
  const read = (deliveryIds: string[]) =>
    runAgentsCommand(
      ["reports", "--conversation", "global-default", "--delivery-ids", deliveryIds.join(",")],
      { env: f.env },
    );
  expect(await read([foreign, unknown])).toEqual({
    conversationId: "global-default",
    unreadCount: 2,
    items: [],
    ackDeliveryIds: [],
  });
  expect(f.store.inboundAcceptance(foreign)?.reportDelivery?.offeredAt).toBeUndefined();
  expect(f.store.inboundAcceptance(unknown)).toBeUndefined();
  expect(f.ids.every((id) => !f.store.inboundAcceptance(id)?.reportDelivery?.offeredAt)).toBe(true);
  for (const deliveryId of [foreign, unknown]) {
    await expect(
      runAgentsCommand(["reports", "ack", deliveryId, "--conversation", "global-default"], {
        env: f.env,
      }),
    ).rejects.toThrow("Only fully offered worker reports may be acknowledged");
  }

  const own = f.store.inboundReports("global-default").at(-1)!;
  const page = WorkerReportPageSchema.parse(await read([foreign, own.deliveryId, unknown]));
  expect(page.items).toEqual([expect.objectContaining({ deliveryId: own.deliveryId, text: own.text })]);
  expect(page.ackDeliveryIds).toEqual([own.deliveryId]);
  expect(JSON.stringify(page)).not.toContain(privateText);
  expect(JSON.stringify(page)).not.toContain(foreign);
  expect(f.store.inboundAcceptance(foreign)?.reportDelivery?.offeredAt).toBeUndefined();
  expect(f.store.inboundReports("global-default")).toHaveLength(2);
  expect(f.store.inboundReports(foreignConversation).map((report) => report.deliveryId)).toEqual([foreign]);
});

it("rejects malformed or unbounded selectors before offering any report (VUH-2188)", async () => {
  const f = await fixture(1);
  for (const deliveryIds of [[], ["not-a-uuid"], Array.from({ length: 101 }, () => f.ids[0]!)]) {
    const response = await f.service.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({
        op: "worker_reports",
        schemaVersion: 1,
        conversationId: "global-default",
        deliveryIds,
      }),
    });
    expect(response.status).toBe(400);
    expect(f.store.inboundAcceptance(f.ids[0]!)?.reportDelivery?.offeredAt).toBeUndefined();
    expect(f.store.inboundReports("global-default")).toHaveLength(1);
  }
});

it("only offers complete selected reports that fit the HTTP page byte budget (VUH-2188)", async () => {
  const fullText = "🦊".repeat(8192);
  const f = await fixture(12, { reportText: () => fullText });
  const unread = f.store.inboundReports("global-default");
  const page = WorkerReportPageSchema.parse(
    await runAgentsCommand(
      ["reports", "--conversation", "global-default", "--delivery-ids", f.ids.join(","), "--limit", "100"],
      { env: f.env },
    ),
  );
  expect(page.unreadCount).toBe(12);
  expect(page.items.length).toBeGreaterThan(0);
  expect(page.items.length).toBeLessThan(12);
  expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(128 * 1024);
  expect(page.items.every((item) => item.text === fullText)).toBe(true);
  expect(page.ackDeliveryIds).toEqual(unread.slice(0, page.items.length).map((report) => report.deliveryId));
  const omitted = unread.slice(page.items.length);
  expect(
    omitted.every((report) => !f.store.inboundAcceptance(report.deliveryId)?.reportDelivery?.offeredAt),
  ).toBe(true);
  await expect(
    runAgentsCommand(["reports", "ack", omitted[0]!.deliveryId, "--conversation", "global-default"], {
      env: f.env,
    }),
  ).rejects.toThrow("Only fully offered worker reports may be acknowledged");
  expect(f.store.inboundReports("global-default")).toHaveLength(12);
  expect(
    await runAgentsCommand(["reports", "ack", ...page.ackDeliveryIds, "--conversation", "global-default"], {
      env: f.env,
    }),
  ).toMatchObject({ acknowledged: page.items.length });
  expect(f.store.inboundReports("global-default").map((report) => report.deliveryId)).toEqual(
    omitted.map((report) => report.deliveryId),
  );
});

it("never tells a worker its question was answered when no reply reached it (VUH-2065)", async () => {
  const f = await fixture(2);
  const page = WorkerReportPageSchema.parse(
    await runAgentsCommand(["reports", "--conversation", "global-default"], { env: f.env }),
  );
  const [question, answered] = page.ackDeliveryIds as [string, string];
  const claim = { summary: "Already answered in this session's messages." };
  // The lead answered elsewhere (the owner's chat): nothing reached the worker.
  expect(
    await runAgentsCommand(
      ["reports", "ack", question, "--conversation", "global-default", "--receipt", JSON.stringify(claim)],
      { env: f.env },
    ),
  ).toEqual({
    conversationId: "global-default",
    acknowledged: 1,
    unanswered: [question],
    instruction: expect.stringContaining("message_seat"),
  });
  const receiptFor = (id: string) =>
    f.store
      .senderReportEvents("w3Z:pCass", "a".repeat(64))
      .find((event) => event.id === `report:${id}:acknowledged`)?.content;
  expect(receiptFor(question)).not.toContain("Already answered");
  expect(receiptFor(question)).toContain("No reply from Clankie has reached you");

  // A lead message that reached the worker answers its earlier reports.
  f.store.recordInboundReportReply("global-default", "w3Z:pCass", "a".repeat(64));
  expect(
    await runAgentsCommand(
      ["reports", "ack", answered, "--conversation", "global-default", "--receipt", JSON.stringify(claim)],
      { env: f.env },
    ),
  ).toEqual({ conversationId: "global-default", acknowledged: 1 });
  expect(receiptFor(answered)).toContain("Already answered in this session's messages.");
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
  f.store.recordInboundReportReply("global-default", "w3Z:pCass", "a".repeat(64));
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
  const f = await fixture(165, { directAcceptance: true });
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
  const f = await fixture(165, { directAcceptance: true });
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
