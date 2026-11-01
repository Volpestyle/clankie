// A hire placed in the desktop app's terminals (ADR 0319) whose start never confirmed, though its
// agent runs: the uncertain original holds every new hire in that checkout until it settles. The
// operator's adoption observes the desktop app's own inventory for its pane, checks the running
// process again, and binds it; a pane only another machine's inventory holds is never adopted.
// Real stores and journals on disk; inventory and process proof are supplied at the runner seam.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeliveryFence, ReceiptSchema } from "../src/captain/delivery-fence.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HERDR_CORE_FLEET } from "../src/captain/herdr-core-runner.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";

const roots: string[] = [];
const stores: HerdrWatchStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function desktopHire(paneId = `${HERDR_CORE_FLEET}/t2k`) {
  const root = await mkdtemp(join(tmpdir(), "desktop-adopt-"));
  roots.push(root);
  const path = join(root, "watch.json");
  const journal = `${path}.hire-receipts.json`;
  const session = {
    source: "herdr:claude",
    kind: "id",
    value: "30000000-0000-4000-8000-000000000003",
  } as const;
  const occupant = occupantIdForHerdrSession(session);
  const owner = { conversationId: "lead" };
  const agent: HerdrAgentSnapshot = {
    paneId,
    terminalId: paneId.split("/").at(-1)!,
    agent: "claude",
    status: "working",
    title: "clankie-app",
    session,
    workingDirectory: root,
    foregroundWorkingDirectory: root,
  };
  const golden = JSON.parse(
    await readFile(
      new URL("./fixtures/hire-receipts/local-unconfirmed-claude-start.json", import.meta.url),
      "utf8",
    ),
  );
  await writeFile(
    `${path}.project-hires.json`,
    JSON.stringify({
      version: 1,
      allocations: [
        {
          ...golden.allocation,
          key: JSON.stringify(["default", root]),
          pane: agent.paneId,
          seat: agent.terminalId,
          occupantId: occupant,
          confirmed: false,
          request: { ...golden.allocation.request, workingDirectory: root },
        },
      ],
    }),
  );
  // The desktop hire's start bound its owner before the launch proof refused.
  new HireOwners(`${path}.owners.json`).bind(
    agent.paneId,
    owner,
    agent.terminalId,
    undefined,
    occupant,
    JSON.stringify([HERDR_CORE_FLEET, "claude", session.value]),
    "clankie-app",
  );
  const key = JSON.stringify(["local", "claude", root, "new"]);
  const receiptId = golden.receipt.messageId as string;
  new DeliveryFence(journal).begin(
    key,
    ReceiptSchema.parse({
      ...golden.receipt,
      paneId: agent.paneId,
      occupantId: occupant,
      sessionId: session.value,
    }),
  );
  const listed: (string | undefined)[] = [];
  const proved: string[] = [];
  const store = new HerdrWatchStore(path, {
    // Herdr's own inventory never lists a desktop-app terminal; the desktop app's does.
    runner: {
      get: async () => agent,
      list: async (fleet?: string) => {
        listed.push(fleet);
        return fleet === HERDR_CORE_FLEET ? [agent] : [];
      },
    } as never,
    projectHirePolicy: {
      settings: async () => {
        throw new Error("No project settings in an adoption proof");
      },
      project: async () => undefined,
      proof: async (fleet: string, pane: string) => {
        proved.push(pane);
        return {
          nativeOccupantId: occupant,
          fleet,
          pane,
          binding: { socketPath: "fixture.sock" },
          shell: { pid: 200, startTime: "shell" },
          processes: [{ pid: 201, startTime: "claude" }],
        };
      },
    },
  });
  stores.push(store);
  return {
    store,
    journal,
    key,
    receiptId,
    listed,
    proved,
    allocation: () =>
      new ProjectHires(`${path}.project-hires.json`).retirementCandidate("default", agent.paneId),
  };
}

it("the operator adopts a running desktop-app hire whose start never confirmed, from the desktop app's inventory", async () => {
  const f = await desktopHire();
  expect(new DeliveryFence(f.journal).pending(f.key)?.messageId).toBe(f.receiptId);

  const adopted = await f.store.settleHireReceipt(f.receiptId, async () => {}, "adopt");
  expect(adopted).toMatchObject({
    state: "adopted",
    receiptId: f.receiptId,
    seat: { paneId: "herdr-core/t2k", seatId: "t2k" },
    owner: { conversationId: "lead" },
  });
  expect(f.listed.every((fleet) => fleet === HERDR_CORE_FLEET)).toBe(true);
  expect(f.proved).toEqual(["herdr-core/t2k"]);
  // The original no longer holds the checkout, and the allocation is the confirmed hire.
  expect(new DeliveryFence(f.journal).pending(f.key)).toBeUndefined();
  expect(new DeliveryFence(f.journal).settlement(f.receiptId)).toMatchObject({ disposition: "adopted" });
  expect(f.allocation()).toMatchObject({ confirmed: true });
});

it("a pane on another machine's inventory is never adopted as this machine's", async () => {
  const f = await desktopHire("pc2/t3");
  expect(await f.store.settleHireReceipt(f.receiptId, async () => {}, "adopt")).toMatchObject({
    state: "refused",
    detail: expect.stringMatching(/not on this machine/u),
  });
  expect(f.listed).toEqual([]);
  expect(new DeliveryFence(f.journal).pending(f.key)?.messageId).toBe(f.receiptId);
});
