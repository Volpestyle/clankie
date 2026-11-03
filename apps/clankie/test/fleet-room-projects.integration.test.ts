import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FleetRoomResultSchema, SpawnOperatorSeatSchema } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { FleetRoomJournal } from "../src/captain/fleet-room.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const settings = ProjectsSettingsSchema.parse({
  projects: [
    { id: "app", name: "App" },
    { id: "game", name: "Game" },
  ],
});
const hire = (title: string, workingDirectory: string) =>
  SpawnOperatorSeatSchema.parse({
    schemaVersion: 1,
    harness: "claude",
    role: "builder",
    title,
    workingDirectory,
  });

it("tags a worker's room lines with the project its hire recorded, only for readers that ask", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-room-projects-"));
  roots.push(root);
  const path = join(root, "herdr-watches.json");
  // The real hire ledger, written the way hiring writes it, then read through the watch store.
  const ledger = new ProjectHires(`${path}.project-hires.json`);
  const started = (
    projectId: string,
    title: string,
    directory: string,
    pane: string,
    seat: string,
    occupant: string,
  ) => {
    const allocation = ledger.reserve(settings, projectId, hire(title, directory));
    ledger.launch(allocation.id, settings);
    ledger.pane(allocation.id, pane);
    ledger.observe(allocation.id, seat, occupant);
    ledger.confirmed(allocation.id);
  };
  started("app", "Wren", "/work/app", "w1:p1", "term_wren", "session-wren");
  started("game", "Juno", "/work/game", "w1:p2", "term_juno", "session-juno");
  const watches = new HerdrWatchStore(path);
  expect(watches.hiredProject("term_wren", "session-wren")).toBe("app");
  expect(watches.hiredProject("term_juno", "session-juno")).toBe("game");
  // A reused seat with a new occupant is not the hire, and no project is guessed for it.
  expect(watches.hiredProject("term_wren", "session-other")).toBeUndefined();

  const worker = (label: string, seatId: string, occupant: string) => {
    const projectId = watches.hiredProject(seatId, occupant);
    return {
      kind: "worker" as const,
      label,
      seatId,
      personaId: `agent-${label}`,
      ...(projectId ? { projectId } : {}),
    };
  };
  const journal = new FleetRoomJournal(join(root, "fleet-room"), () => new Date("2026-11-03T12:00:00.000Z"));
  const lead = { kind: "lead" as const, label: "Clankie", conversationId: "global-default" };
  const at = "2026-11-03T12:00:00.000Z";
  journal.record({
    id: "report:wren",
    at,
    kind: "worker_report",
    from: worker("Wren", "term_wren", "session-wren"),
    to: lead,
    text: "PR is up",
  });
  journal.record({
    id: "peer:juno",
    at,
    kind: "peer_message",
    from: worker("Juno", "term_juno", "session-juno"),
    to: worker("Wren", "term_wren", "session-wren"),
    text: "Rebased",
  });
  journal.record({
    id: "report:stray",
    at,
    kind: "worker_report",
    from: worker("Stray", "term_wren", "session-other"),
    to: lead,
    text: "Hello",
  });

  const asked = FleetRoomResultSchema.parse(await journal.read({ projects: true }));
  if (asked.outcome !== "ready") throw new Error("Fleet room unavailable");
  expect(asked.entries.map((entry) => [entry.id, entry.from.projectId, entry.to?.projectId])).toEqual([
    ["report:wren", "app", undefined],
    ["peer:juno", "game", "app"],
    ["report:stray", undefined, undefined],
  ]);

  // A reader that doesn't ask, like an app built before projects, gets the page it always did.
  for (const page of [
    await journal.read({}),
    await new FleetRoomJournal(join(root, "fleet-room")).read({ direction: "newer", cursor: "0" }),
  ]) {
    if (page.outcome !== "ready") throw new Error("Fleet room unavailable");
    expect(JSON.stringify(page)).not.toContain("projectId");
    expect(page.entries).toHaveLength(3);
  }
});
