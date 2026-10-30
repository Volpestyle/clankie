import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FleetRoomJournal, type FleetRoomRecord } from "../src/captain/fleet-room.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 3_600_000;
const lead = { kind: "lead" as const, label: "Clankie", conversationId: "global-default" };
const worker = { kind: "worker" as const, label: "Wren", seatId: "term_wren" };
const report = (id: string, at: Date, text = "Ready for review"): FleetRoomRecord => ({
  id,
  at: at.toISOString(),
  kind: "worker_report",
  from: worker,
  to: lead,
  text,
  delivery: { stage: "stored" },
});

it("keeps the room's sequence across a restart after every entry aged out, and repairs a torn line (VUH-2184)", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-room-"));
  roots.push(root);
  let now = new Date("2026-10-01T12:00:00.000Z");
  const clock = () => now;
  const first = new FleetRoomJournal(root, clock);
  for (const id of ["report:a", "report:b", "report:c"]) first.record(report(id, now));
  const page = await first.read({});
  if (page.outcome !== "ready") throw new Error("Fleet room unavailable");
  expect(page.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);

  // Fifteen quiet days: everything has aged out and is compacted away; the service restarts again.
  now = new Date(now.getTime() + 15 * DAY);
  new FleetRoomJournal(root, clock);
  expect(readFileSync(join(root, "entries.jsonl"), "utf8")).toBe("");
  const restarted = new FleetRoomJournal(root, clock);
  const empty = await restarted.read({});
  expect(empty).toMatchObject({ outcome: "ready", entries: [], older: null, newer: "3" });
  // A follower holding cursor 3 hears the next entry; numbering never restarts at 1.
  const waiting = restarted.read({ direction: "newer", cursor: "3", waitMs: 2000 });
  restarted.record(report("report:d", now));
  expect(await waiting).toMatchObject({ entries: [{ id: "report:d", sequence: 4 }] });

  // A crash mid-append leaves a torn line; the next good entry still lands and survives restart.
  appendFileSync(join(root, "entries.jsonl"), '{"id":"report:torn","seq');
  const afterCrash = new FleetRoomJournal(root, clock);
  afterCrash.record(report("report:e", now));
  const again = await new FleetRoomJournal(root, clock).read({});
  expect(again).toMatchObject({ entries: [{ id: "report:d" }, { id: "report:e", sequence: 5 }] });
  expect(readFileSync(join(root, "since.json"), "utf8")).toContain('"sequence":5');
});

it("shows readers the newest 2000 entries, pages back through them once each, and links only real issue keys and SHAs (VUH-2184)", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-room-"));
  roots.push(root);
  const now = new Date("2026-10-16T12:00:00.000Z");
  const journal = new FleetRoomJournal(root, () => now);
  for (let index = 1; index <= 2100; index += 1) journal.record(report(`report:${index}`, now));
  // The same source id is one line, however often it is recorded.
  expect(journal.record(report("report:2100", now))).toBeUndefined();
  const seen: number[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await journal.read({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    if (page.outcome !== "ready") throw new Error("Fleet room unavailable");
    seen.unshift(...page.entries.map((entry) => entry.sequence));
    if (page.older === null) break;
    cursor = page.older;
  }
  expect(seen).toHaveLength(2000);
  expect(seen[0]).toBe(101);
  expect(new Set(seen).size).toBe(2000);

  const linked = journal.record(
    report(
      "report:links",
      now,
      "Landed 7d7a4063d for VUH-2184 (see LOCAL-VUH-18); hashed with SHA-256 over UTF-8. Delivery 123e4567-e89b-42d3-a456-426614174000.",
    ),
  );
  expect(linked?.links).toEqual({ issues: ["VUH-2184", "LOCAL-VUH-18"], commits: ["7d7a4063d"] });
});

it("keeps app notes out of every page that doesn't opt in, and reads the board after a cursor across restart (ADR 0301)", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-room-"));
  roots.push(root);
  const now = new Date("2026-10-30T12:00:00.000Z");
  const journal = new FleetRoomJournal(root, () => now);
  journal.record(report("report:a", now));
  expect(
    journal.postAppNote("Claude", "Reviewing the kh2 PR; api_key=sk-live-1234567890abcdef"),
  ).toMatchObject({
    outcome: "posted",
    note: { sequence: 2, author: "Claude" },
  });
  journal.record(report("report:b", now));

  // An older reader's page: the same room it always read, its cursors stepping over the note.
  const plain = await journal.read({});
  if (plain.outcome !== "ready") throw new Error("Fleet room unavailable");
  expect(plain.entries.map((entry) => entry.id)).toEqual(["report:a", "report:b"]);
  expect(await journal.read({ cursor: "3", limit: 1 })).toMatchObject({
    entries: [{ id: "report:a" }],
    older: null,
  });
  const opted = await journal.read({ include: ["app_note"] });
  if (opted.outcome !== "ready") throw new Error("Fleet room unavailable");
  expect(opted.entries.map((entry) => entry.kind)).toEqual(["worker_report", "app_note", "worker_report"]);
  expect(opted.entries[1]).toMatchObject({ from: { kind: "app", label: "Claude" }, to: null });
  expect(opted.entries[1]!.text).not.toContain("sk-live-1234567890abcdef");

  // A note wakes a follower that didn't ask for notes without ending its wait.
  const waiting = journal.read({ direction: "newer", cursor: "3", waitMs: 2000 });
  journal.postAppNote("Grok", "Taking the docs.");
  await new Promise((resolve) => setTimeout(resolve, 50));
  journal.record(report("report:c", now));
  expect(await waiting).toMatchObject({ entries: [{ id: "report:c", sequence: 5 }], newer: "5" });

  const restarted = new FleetRoomJournal(root, () => now);
  expect(restarted.readAppNotes({})).toMatchObject({
    outcome: "ready",
    notes: [
      { sequence: 2, author: "Claude" },
      { sequence: 4, author: "Grok", text: "Taking the docs." },
    ],
    newer: "5",
  });
  expect(restarted.readAppNotes({ cursor: "2" })).toMatchObject({ notes: [{ sequence: 4 }], newer: "4" });
  expect(restarted.readAppNotes({ cursor: "5" })).toEqual({ outcome: "ready", notes: [], newer: "5" });
  expect(restarted.readAppNotes({ limit: 1 })).toMatchObject({ notes: [{ sequence: 4 }] });
});
