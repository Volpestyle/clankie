import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { createWorkerReports, type WorkerReportsContext } from "../src/captain/captain-worker-reports.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { PaneTidy, tidySessionKey } from "../src/captain/pane-tidy.ts";

// VUH-2806: the real conversation store, inbound receipts and keep journal against a Herdr
// inventory boundary. The same code ran on a copy of the live store with live Herdr
// (docs/testing/2026-10-25-vuh-2806).
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const authority: ConversationAuthority = {
  owner: { conversationId: "global-default" },
  current: () => true,
  authorize: async () => true,
};
const HOUR = 60 * 60_000;

function agent(paneId: string, terminalId: string, session?: string): HerdrAgentSnapshot {
  return {
    paneId,
    terminalId,
    agent: "codex",
    status: "idle",
    title: paneId,
    workingDirectory: "/tmp",
    ...(session === undefined
      ? {}
      : { session: { source: "herdr:codex", kind: "id" as const, value: session } }),
  } as HerdrAgentSnapshot;
}

/** Herdr's inventory per fleet; a missing fleet cannot be listed. */
function inventoryRunner(fleets: Map<string | undefined, HerdrAgentSnapshot[]>): HerdrWatchRunner {
  const all = () => [...fleets.values()].flat();
  return {
    list: async (fleet?: string) => {
      const listed = fleets.get(fleet);
      if (listed === undefined)
        throw new Error(`Complete Herdr inventory unavailable for ${fleet ?? "local"}`);
      return listed;
    },
    get: async (target: string) => {
      const found = all().find((item) => item.paneId === target || item.terminalId === target);
      if (!found) throw new Error("pane not found");
      return found;
    },
  } as unknown as HerdrWatchRunner;
}

async function reportStore(
  root: string,
  reports: { paneId: string; state: "delivered" | "uncertain" | "pending"; ageMs: number }[],
  now: number,
) {
  const path = join(root, "conversations");
  let store = new ConversationStore(path, async () => {
    throw new Error("Retirement never runs a turn");
  });
  const receipts = new InboundSeatReceipts(join(root, "receipts.json"), store);
  const ids: string[] = [];
  for (const [index, report] of reports.entries()) {
    const id = randomUUID();
    ids.push(id);
    const text = `Report ${index} from ${report.paneId}`;
    expect(
      receipts.accept(
        report.paneId,
        { id, binding: deliveryFingerprint(report.paneId) },
        text,
        `Worker output: ${text}`,
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
  for (const [index, report] of reports.entries()) {
    const receipt = metadata.inboundAcceptances[ids[index]!];
    receipt.acceptedAt = new Date(now - report.ageMs).toISOString();
    receipt.reportDelivery =
      report.state === "delivered"
        ? { state: "delivered", stage: "consumed", deliveredAt: receipt.acceptedAt }
        : report.state === "pending"
          ? { state: "pending", stage: "unavailable" }
          : { state: "uncertain", stage: "uncertain" };
  }
  await writeFile(metaPath, JSON.stringify(metadata));
  store = new ConversationStore(path, async () => {
    throw new Error("Retirement never runs a turn");
  });
  return { store, ids, path };
}

function reportHelpers(store: ConversationStore, runner: HerdrWatchRunner, root: string) {
  return createWorkerReports({
    conversations: store,
    herdrRunner: runner,
    retiredReportsPath: join(root, "retired-worker-reports.jsonl"),
    shutdown: new AbortController(),
    onChange: () => undefined,
  } as unknown as WorkerReportsContext);
}

it("retires unread reports only from panes their own listed fleet no longer shows, keeping their text", async () => {
  const root = await mkdtemp(join(tmpdir(), "closed-seat-reports-"));
  roots.push(root);
  const now = Date.now();
  const { store, ids, path } = await reportStore(
    root,
    [
      { paneId: "w1:pLive", state: "delivered", ageMs: 3 * HOUR },
      { paneId: "w1:pGone", state: "delivered", ageMs: 3 * HOUR },
      { paneId: "w1:pGone", state: "uncertain", ageMs: 2 * HOUR },
      // Within the grace hour of a seat that just closed.
      { paneId: "w1:pGone", state: "delivered", ageMs: 10 * 60_000 },
      // Still owed a delivery, so never retired.
      { paneId: "w1:pGone", state: "pending", ageMs: 3 * HOUR },
      // A remote fleet that cannot be listed proves nothing.
      { paneId: "pc/w2:pFar", state: "delivered", ageMs: 3 * HOUR },
    ],
    now,
  );
  const fleets = new Map<string | undefined, HerdrAgentSnapshot[]>([
    // A live pane that changed session keeps every report it ever sent.
    [undefined, [agent("w1:pLive", "term_live", "10000000-0000-4000-8000-00000000000a")]],
  ]);
  const unread = () =>
    store
      .inboundReports("global-default")
      .map((report) => report.deliveryId)
      .sort();
  expect(unread()).toEqual([...ids].sort());

  let reports = reportHelpers(store, inventoryRunner(fleets), root);
  expect(await reports.retireClosedSeatReports(now)).toEqual([
    { conversationId: "global-default", deliveryIds: [ids[1], ids[2]] },
  ]);
  expect(unread()).toEqual([ids[0], ids[3], ids[4], ids[5]].sort());
  // Marked read with no acknowledgment to the gone sender.
  const retired = store
    .inboundReports("global-default", { includeRead: true })
    .find((report) => report.deliveryId === ids[1])!;
  expect(retired.reportDelivery).toMatchObject({ state: "read", stage: "consumed" });
  expect(retired.reportDelivery.acknowledgment).toBeUndefined();
  expect(store.senderReportEvents("w1:pGone", deliveryFingerprint("w1:pGone"))).toEqual([]);
  const audit = (await readFile(join(root, "retired-worker-reports.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(audit).toMatchObject([
    {
      reason: "sender_pane_closed",
      conversationId: "global-default",
      deliveryId: ids[1],
      paneId: "w1:pGone",
      state: "delivered",
      text: "Report 1 from w1:pGone",
    },
    { deliveryId: ids[2], state: "uncertain", text: "Report 2 from w1:pGone" },
  ]);
  expect(
    store["readEvents"]("global-default")
      .filter((event) => event.type === "message" && event.role === "external")
      .map((event) => (event as { text: string }).text),
  ).toEqual([expect.stringMatching(/^Retired 2 unread worker reports whose seat has closed/u)]);

  // The retirement survives a restart; a second sweep an hour later retires the graced report.
  await store.close();
  const reopened = new ConversationStore(path, async () => {
    throw new Error("Retirement never runs a turn");
  });
  expect(
    reopened
      .inboundReports("global-default")
      .map((report) => report.deliveryId)
      .sort(),
  ).toEqual([ids[0], ids[3], ids[4], ids[5]].sort());
  reports = reportHelpers(reopened, inventoryRunner(fleets), root);
  expect(await reports.retireClosedSeatReports(now + HOUR)).toEqual([
    { conversationId: "global-default", deliveryIds: [ids[3]] },
  ]);
  // Once the remote fleet lists without that pane, its report goes too.
  fleets.set("pc", [agent("pc/w2:pOther", "pc/term_other", "10000000-0000-4000-8000-00000000000b")]);
  expect(await reports.retireClosedSeatReports(now + HOUR)).toEqual([
    { conversationId: "global-default", deliveryIds: [ids[5]] },
  ]);
  expect(
    reopened
      .inboundReports("global-default")
      .map((report) => report.deliveryId)
      .sort(),
  ).toEqual([ids[0], ids[4]].sort());
  expect(
    (await readFile(join(root, "retired-worker-reports.jsonl"), "utf8")).trim().split("\n"),
  ).toHaveLength(4);
  await reopened.close();
});

it("drops keeps only when their pane and session are gone from a listed fleet, and releases a gone pane by id", async () => {
  const root = await mkdtemp(join(tmpdir(), "closed-seat-keeps-"));
  roots.push(root);
  const live = agent("w1:pLive", "term_live", "10000000-0000-4000-8000-000000000001");
  // Herdr can show a live Codex pane without its session; the pane alone holds its keep.
  const sessionless = agent("w1:pBare", "term_bare");
  // A session that moved to another pane is still alive.
  const moved = agent("w1:pMoved", "term_moved", "10000000-0000-4000-8000-000000000003");
  const keepFor = (paneId: string, sessionKey: string) => ({
    sessionKey,
    paneId,
    title: paneId,
    reason: "Kept for follow-up",
    by: "global-default",
    at: "2026-10-18T09:02:35.724Z",
  });
  const goneKey = JSON.stringify(["local", "codex", "10000000-0000-4000-8000-000000000009"]);
  const keeps = [
    keepFor(live.paneId, tidySessionKey(live)),
    keepFor(sessionless.paneId, JSON.stringify(["local", "codex", "10000000-0000-4000-8000-000000000002"])),
    keepFor("w1:pOld", tidySessionKey(moved)),
    keepFor("w1:pGone", goneKey),
    keepFor("w1:pReleased", JSON.stringify(["local", "codex", "10000000-0000-4000-8000-000000000008"])),
    keepFor("pc/w2:pFar", JSON.stringify(["pc", "claude", "20000000-0000-4000-8000-000000000001"])),
  ];
  await writeFile(join(root, "pane-keeps.json"), JSON.stringify({ version: 1, keeps }));
  const fleets = new Map<string | undefined, HerdrAgentSnapshot[]>([[undefined, [live, sessionless, moved]]]);
  let changes = 0;
  const tidy = new PaneTidy(join(root, "pane-tidy.json"), {
    runner: inventoryRunner(fleets),
    changed: () => changes++,
  } as unknown as ConstructorParameters<typeof PaneTidy>[1]);

  // Releasing a gone pane by its old id no longer refuses pane_unknown.
  expect(await tidy.keep({ pane: "w1:pReleased", keep: false }, authority)).toMatchObject({
    outcome: "released",
    paneId: "w1:pReleased",
  });
  expect(await tidy.keep({ pane: "w1:pNever", keep: false }, authority)).toMatchObject({
    outcome: "not_kept",
  });
  // Keeping a gone pane still fails as before.
  expect(await tidy.keep({ pane: "w1:pGone", keep: true }, authority)).toMatchObject({
    reason: "pane_unknown",
  });

  expect((await tidy.dropGoneKeeps()).map((keep) => keep.paneId)).toEqual(["w1:pGone"]);
  expect(changes).toBe(2);
  const remaining = ["w1:pLive", "w1:pBare", "w1:pOld", "pc/w2:pFar"];
  expect(tidy.keptPane(live)?.paneId).toBe("w1:pLive");
  // Durable, and a second sweep over the same inventory drops nothing.
  const reopened = new PaneTidy(join(root, "pane-tidy.json"), {
    runner: inventoryRunner(fleets),
    changed: () => changes++,
  } as unknown as ConstructorParameters<typeof PaneTidy>[1]);
  expect(await reopened.dropGoneKeeps()).toEqual([]);
  expect(
    JSON.parse(await readFile(join(root, "pane-keeps.json"), "utf8")).keeps.map(
      (keep: { paneId: string }) => keep.paneId,
    ),
  ).toEqual(remaining);
  // The remote keep goes only once its own fleet lists without it.
  fleets.set("pc", []);
  expect((await reopened.dropGoneKeeps()).map((keep) => keep.paneId)).toEqual(["pc/w2:pFar"]);
});
