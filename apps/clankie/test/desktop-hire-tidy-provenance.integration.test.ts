// #584: a hire in the desktop app's terminals (ADR 0319) records its native session as this
// machine's ("local"), since the router places it after its owner is bound. Tidy looked the
// session up under the desktop app's own fleet name, found a claim it could not match, and
// called every desktop hire's provenance unknown, so neither auto-tidy nor a lead's close
// could retire one. Real owner journal on disk; the runner seam supplies the pane.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HERDR_CORE_FLEET } from "../src/captain/herdr-core-runner.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";

const roots: string[] = [];
const stores: HerdrWatchStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("a desktop hire recorded as this machine's is its lead's to retire, and a finished one is known by its session", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-tidy-"));
  roots.push(root);
  const path = join(root, "watch.json");
  const session = {
    source: "herdr:claude",
    kind: "id",
    value: "40000000-0000-4000-8000-000000000004",
  } as const;
  const seatId = `${HERDR_CORE_FLEET}/t6p`;
  const agent: HerdrAgentSnapshot = {
    paneId: seatId,
    terminalId: seatId,
    agent: "claude",
    status: "done",
    title: "Clankie captain brief",
    session,
    workingDirectory: root,
  };
  // As the hire path binds it: the requested fleet, which a desktop placement leaves unset.
  new HireOwners(`${path}.owners.json`).bind(
    seatId,
    { conversationId: "lead" },
    seatId,
    undefined,
    occupantIdForHerdrSession(session),
    JSON.stringify(["local", "claude", session.value]),
    "clankie",
  );
  const store = new HerdrWatchStore(path, {
    runner: { get: async () => agent, list: async () => [] } as never,
  });
  stores.push(store);

  expect(store.tidyProvenance(agent)).toEqual({ conversationId: "lead" });
  expect(store.hiredSession(seatId, "claude", session.value)).toBe(true);
  // Another session in the same terminal, or another terminal, is not that hire.
  expect(store.hiredSession(seatId, "claude", "50000000-0000-4000-8000-000000000005")).toBe(false);
  expect(store.hiredSession(`${HERDR_CORE_FLEET}/t6q`, "claude", session.value)).toBe(false);
});
