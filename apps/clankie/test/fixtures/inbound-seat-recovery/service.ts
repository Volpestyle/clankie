import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { FleetSeatMessageSchema } from "@clankie/protocol";
import { BodyLeaseStore } from "../../../src/body-leases.ts";
import { ConversationStore } from "../../../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../../../src/captain/inbound-seat-receipts.ts";

const [root, mode, instanceId, deadlineText] = process.argv.slice(2);
if (
  !root ||
  !instanceId ||
  !["normal", "pipe", "hold", "hold-abort", "hold-shutdown", "storage-failure", "journal-failure"].includes(
    mode ?? "",
  )
)
  throw new Error("Missing inbound recovery fixture arguments");
const deadlineMs = Number(deadlineText ?? 30_000);
const leases = new BodyLeaseStore(join(root, "body"));
const shutdown = new AbortController();
const conversationRoot = join(root, "conversations");
const faultPath = join(conversationRoot, "global-default", "meta.json.tmp");
const journalFaultPath = join(conversationRoot, "global-default", "events.jsonl");
if (mode === "normal") {
  // Restore only the fixture's failed storage dependency. Receipts and claims
  // remain untouched; the production lookup must recover those itself.
  for (const path of [faultPath, journalFaultPath]) {
    const previous = statSync(path, { throwIfNoEntry: false });
    if (previous?.isFIFO() || previous?.isDirectory())
      renameSync(path, join(root, `storage-fault-${randomUUID()}`));
  }
}
const store = new ConversationStore(conversationRoot, async (_id, message) => {
  appendFileSync(join(root, "effects.jsonl"), `${JSON.stringify({ message })}\n`);
});
const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store, {
  instanceId,
  deadlineMs,
  signal: shutdown.signal,
});
if (mode === "pipe") execFileSync("mkfifo", [faultPath]);
if (mode === "storage-failure") mkdirSync(faultPath);
if (mode === "journal-failure") mkdirSync(journalFaultPath);
let release!: () => void;
const held = new Promise<void>((resolve) => {
  release = resolve;
});
let firstPost = true;
process.on("message", (message) => {
  if (message === "release") release();
  if (message === "shutdown") {
    shutdown.abort();
    leases.close();
    process.send?.({ state: "shutdown" });
  }
});
const server = createServer(async (request, response) => {
  const deadlineAt = Date.now() + deadlineMs;
  const interrupted = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) {
      interrupted.abort();
      process.send?.({ state: "aborted" });
    }
  });
  response.on("error", () => {});
  if (request.headers.authorization !== "Bearer fixture-inbound-token") {
    response.writeHead(403).end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://fixture");
  const match = /^\/v1\/fleet\/seats\/([^/]+)\/messages(?:\/([^/]+))?$/u.exec(url.pathname);
  if (!match) {
    response.writeHead(404).end();
    return;
  }
  const pane = decodeURIComponent(match[1]!);
  if (request.headers["x-clankie-pane"] !== pane) {
    response.writeHead(403).end();
    return;
  }
  const reply = (body: unknown) =>
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  try {
    if (request.method === "GET") {
      appendFileSync(
        join(root, "http.jsonl"),
        `${JSON.stringify({ method: "GET", pane, id: match[2] ?? null })}\n`,
      );
      if (!match[2]) {
        reply({ binding: "a".repeat(64) });
        return;
      }
      reply(
        receipts.lookup(
          pane,
          { id: match[2], binding: url.searchParams.get("binding") ?? "" },
          url.searchParams.get("fingerprint") ?? "",
        ),
      );
      return;
    }
    if (request.method !== "POST" || match[2]) {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = FleetSeatMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!input.delivery) {
      response.writeHead(400).end();
      return;
    }
    const delivery = input.delivery;
    appendFileSync(
      join(root, "http.jsonl"),
      `${JSON.stringify({ method: "POST", pane, id: delivery.id })}\n`,
    );
    const shouldHold = mode?.startsWith("hold") && firstPost;
    firstPost = false;
    const receipt = await receipts.trackAttempt(
      pane,
      delivery,
      input.text,
      async () => {
        if (shouldHold) {
          process.send?.({ state: "held", id: delivery.id });
          await held;
        }
        return receipts.accept(pane, delivery, input.text, `Worker output: ${input.text}`);
      },
      { deadlineAt, ...(mode === "hold-abort" ? { signal: interrupted.signal } : {}) },
    );
    if (mode === "storage-failure" && statSync(faultPath, { throwIfNoEntry: false })?.isDirectory())
      renameSync(faultPath, join(root, `storage-fault-${randomUUID()}`));
    process.send?.({ state: "settled", id: delivery.id, receipt });
    reply(receipt);
  } catch (error) {
    response
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: String(error) }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing inbound fixture address");
  process.send?.({ state: "ready", port: address.port, instanceId });
});
