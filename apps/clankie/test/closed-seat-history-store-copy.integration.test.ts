import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createWorkerReports, type WorkerReportsContext } from "../src/captain/captain-worker-reports.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { createRemoteHerdrRunner, routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { createHerdrFleetRun, splitFleetQualified, type HerdrFleet } from "../src/herdr-fleet.ts";

// VUH-2806 real-data proof: a copy of the live captain store (conversations/ and
// pane-keeps.json) against this Mac's live Herdr and any remote fleets named in
// VUH2806_FLEETS (the service's own ssh transport), listing only. An unnamed or unreachable
// fleet cannot be listed and must keep everything. Counts only leave the copy.
// The test setup strips CLANKIE_ and HERDR_ variables and replaces HOME, so the proof takes
// its copy, output and the live Herdr socket under its own names.
const copy = process.env.VUH2806_STORE_COPY;
it.skipIf(!copy || process.platform !== "darwin")(
  "retires only gone seats' history on a copy of the live store",
  async () => {
    const root = resolve(copy!);
    expect(root).not.toBe(resolve(homedir(), ".clankie/captain"));
    expect(root).not.toBe(resolve(process.env.VUH2806_LIVE_STORE ?? "", "."));
    process.env.HERDR_SOCKET_PATH = process.env.VUH2806_HERDR_SOCKET;
    const fleets = JSON.parse(process.env.VUH2806_FLEETS ?? "[]") as HerdrFleet[];
    const ssh = await mkdtemp("/tmp/v2806-");
    const runner = routeHerdrFleets(
      createHerdrWatchRunner(() => true, undefined, undefined, { localCodexRecovery: false }),
      new Map(
        fleets.map((fleet) => [
          fleet.id,
          createRemoteHerdrRunner(
            fleet,
            // ssh control sockets must stay under Darwin's 104-byte socket path limit.
            createHerdrFleetRun(fleet, { controlDirectory: ssh }),
          ),
        ]),
      ),
    );
    const listed = new Set((await runner.list!()).map((agent) => agent.paneId));
    const listedFleets = new Set<string>(["local"]);
    const fleetErrors: string[] = [];
    for (const fleet of fleets)
      await runner.list!(fleet.id).then(
        (inventory) => {
          listedFleets.add(fleet.id);
          for (const agent of inventory) listed.add(agent.paneId);
        },
        (error: unknown) => fleetErrors.push(`${fleet.id}: ${String(error).slice(0, 300)}`),
      );
    const conversations = () =>
      new ConversationStore(join(root, "conversations"), async () => {
        throw new Error("The proof never runs a turn");
      });
    let store = conversations();
    const before = store.inboundReports();
    const keepsBefore = JSON.parse(await readFile(join(root, "pane-keeps.json"), "utf8")).keeps as {
      paneId: string;
      sessionKey: string;
    }[];
    const now = Date.now();
    const reports = createWorkerReports({
      conversations: store,
      herdrRunner: runner,
      retiredReportsPath: join(root, "retired-worker-reports.jsonl"),
      shutdown: new AbortController(),
      onChange: () => undefined,
    } as unknown as WorkerReportsContext);
    const retired = await reports.retireClosedSeatReports(now);
    const retiredIds = new Set(retired.flatMap((entry) => entry.deliveryIds));
    const tidy = new PaneTidy(join(root, "pane-tidy.json"), {
      runner,
      changed: () => undefined,
    } as unknown as ConstructorParameters<typeof PaneTidy>[1]);
    const dropped = await tidy.dropGoneKeeps();
    await store.close();

    // Every retired report was handed over or uncertain, over an hour old, from a pane its
    // listed fleet no longer shows. Every other unread report is untouched, across a reopen.
    const local = (paneId: string) => listedFleets.has(splitFleetQualified(paneId)?.fleet ?? "local");
    for (const report of before) {
      const eligible =
        local(report.paneId) &&
        !listed.has(report.paneId) &&
        ["delivered", "uncertain"].includes(report.reportDelivery.state) &&
        Date.parse(report.acceptedAt) <= now - 60 * 60_000;
      expect(retiredIds.has(report.deliveryId), report.deliveryId).toBe(eligible);
    }
    store = conversations();
    const after = store.inboundReports();
    expect(after.map((report) => report.deliveryId).sort()).toEqual(
      before
        .filter((report) => !retiredIds.has(report.deliveryId))
        .map((report) => report.deliveryId)
        .sort(),
    );
    const audit = (await readFile(join(root, "retired-worker-reports.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { deliveryId: string; text: string });
    const texts = new Map(before.map((report) => [report.deliveryId, report.text]));
    expect(audit.map((entry) => entry.deliveryId).sort()).toEqual([...retiredIds].sort());
    for (const entry of audit) expect(entry.text).toBe(texts.get(entry.deliveryId));
    await store.close();

    // Keeps: only those whose pane its listed fleet no longer shows went.
    const keepsAfter = JSON.parse(await readFile(join(root, "pane-keeps.json"), "utf8")).keeps as {
      paneId: string;
    }[];
    for (const keep of keepsBefore)
      expect(
        dropped.some((item) => item.sessionKey === keep.sessionKey),
        keep.paneId,
      ).toBe(local(keep.paneId) && !listed.has(keep.paneId));
    expect(keepsAfter).toHaveLength(keepsBefore.length - dropped.length);

    const byConversation = (list: typeof before) =>
      Object.fromEntries(
        [...new Set(list.map((report) => report.conversationId))].map((id) => [
          id,
          list.filter((report) => report.conversationId === id).length,
        ]),
      );
    const liveUnread = after.filter((report) => listed.has(report.paneId));
    const result = {
      ranAt: new Date(now).toISOString(),
      listedFleets: [...listedFleets],
      fleetErrors,
      listedPanes: listed.size,
      unreadBefore: byConversation(before),
      unreadAfter: byConversation(after),
      retired: retiredIds.size,
      remaining: {
        fromListedPanes: liveUnread.length,
        fromUnlistedFleets: after.filter((report) => !local(report.paneId)).length,
        withinGraceHour: after.filter(
          (report) => !listed.has(report.paneId) && Date.parse(report.acceptedAt) > now - 60 * 60_000,
        ).length,
        pending: after.filter((report) => report.reportDelivery.state === "pending").length,
      },
      keeps: {
        before: keepsBefore.length,
        dropped: dropped.map((keep) => ({ paneId: keep.paneId, at: keep.at })),
        after: keepsAfter.map((keep) => keep.paneId),
      },
    };
    await rm(ssh, { recursive: true, force: true });
    if (process.env.VUH2806_PROOF_OUT)
      await writeFile(process.env.VUH2806_PROOF_OUT, `${JSON.stringify(result, null, 2)}\n`);
  },
  120_000,
);
