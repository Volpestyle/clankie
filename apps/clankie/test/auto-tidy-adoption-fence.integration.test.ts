// VUH-2802 review: an unconfirmed hire's original receipt fences its retirement until it is
// settled. A failed or partial adoption must never release that fence, now or after a restart.
// Real stores and journals on disk; process observation is supplied at the runner seam.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAutoTidy } from "../src/captain/auto-tidy.ts";
import { DeliveryFence, ReceiptSchema } from "../src/captain/delivery-fence.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";

const roots: string[] = [];
const stores: HerdrWatchStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(confirmed = false) {
  const root = await mkdtemp(join(tmpdir(), "auto-tidy-fence-"));
  roots.push(root);
  const path = join(root, "watch.json");
  const journal = `${path}.hire-receipts.json`;
  const session = {
    source: "herdr:claude",
    kind: "id",
    value: "20000000-0000-4000-8000-000000000002",
  } as const;
  const occupant = occupantIdForHerdrSession(session);
  const owner = { conversationId: "lead" };
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_fence",
    agent: "claude",
    status: "idle",
    title: "Juniper",
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
  const proof = {
    nativeOccupantId: occupant,
    fleet: "default",
    pane: agent.paneId,
    binding: { socketPath: "fixture.sock", session: "fixture" },
    shell: { pid: 100, startTime: "shell" },
    processes: [{ pid: 101, startTime: "claude" }],
  };
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
          proof,
          confirmed,
          request: { ...golden.allocation.request, workingDirectory: root },
        },
      ],
    }),
  );
  new HireOwners(`${path}.owners.json`).bind(
    agent.paneId,
    owner,
    agent.terminalId,
    undefined,
    occupant,
    JSON.stringify(["local", "claude", session.value]),
    "clankie",
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
  let fault: (() => Promise<void>) | undefined;
  const open = () => {
    const store = new HerdrWatchStore(path, {
      runner: { get: async () => agent, list: async () => [agent] } as never,
      projectHirePolicy: {
        settings: async () => {
          throw new Error("No project settings in a fence proof");
        },
        project: async () => undefined,
        proof: async () => {
          const once = fault;
          fault = undefined;
          await once?.();
          return proof;
        },
      },
    });
    stores.push(store);
    return store;
  };
  const retires = async (store: HerdrWatchStore) => {
    try {
      await (
        await store.retirementGuard(agent)
      )();
      return true;
    } catch {
      return false;
    }
  };
  return {
    path,
    journal,
    key,
    receiptId,
    agent,
    owner,
    open,
    retires,
    allocation: () =>
      new ProjectHires(`${path}.project-hires.json`).retirementCandidate("default", agent.paneId),
    // The receipt journal's atomic rename fails: its path is briefly a directory.
    breakJournal: () => {
      fault = async () => {
        await rename(journal, `${journal}.held`);
        await mkdir(journal);
      };
    },
    repairJournal: async () => {
      await rm(journal, { recursive: true });
      await rename(`${journal}.held`, journal);
    },
  };
}

it("a failed automatic adoption keeps retirement fenced and auto-tidy holding, across restart, until it settles", async () => {
  const f = await fixture();
  const store = f.open();
  f.breakJournal();
  const failed = await store.adoptUnconfirmedForTidy(f.agent, f.owner, async () => {});
  expect(failed).toMatchObject({ state: "refused", detail: expect.stringMatching(/EISDIR|ENOTDIR|EEXIST/u) });
  expect(f.allocation()).toMatchObject({ confirmed: false });
  expect(await f.retires(store)).toBe(false);

  // Auto-tidy holds the pane instead of closing it after a refused adoption.
  let closes = 0;
  f.breakJournal();
  const auto = createAutoTidy({
    setting: async () => "1h",
    runner: { list: async () => [f.agent] },
    tidy: {
      close: async () => {
        closes++;
        return { outcome: "failed", reason: "provenance_unknown" };
      },
      keptPane: () => undefined,
      keepVersion: () => 0,
      hasKeptReport: () => true,
    },
    provenance: (agent) => store.tidyProvenance(agent),
    unreadReports: () => 0,
    ownerValid: async () => true,
    adoptUnconfirmed: (agent, owner, guard) => store.adoptUnconfirmedForTidy(agent, owner, guard),
    closed: async () => {},
    checkouts: async () => [],
    prune: async () => {
      throw new Error("No prune in a fence proof");
    },
    stopped: () => false,
    now: (() => {
      let clock = Date.now();
      return () => (clock += 61 * 60_000);
    })(),
  });
  await auto.panes();
  expect(await auto.panes()).toEqual([]);
  expect(closes).toBe(0);
  expect(auto.held(f.owner.conversationId)).toMatchObject([{ blocker: "adoption_refused" }]);

  // Restart with the journal readable again: the original is still unsettled and still fences.
  store.close();
  await f.repairJournal();
  const reopened = f.open();
  expect(new DeliveryFence(f.journal).pending(f.key)?.messageId).toBe(f.receiptId);
  expect(await f.retires(reopened)).toBe(false);
  expect(await reopened.adoptUnconfirmedForTidy(f.agent, f.owner, async () => {})).toMatchObject({
    state: "adopted",
    receiptId: f.receiptId,
  });
  expect(new DeliveryFence(f.journal).settlement(f.receiptId)).toMatchObject({ disposition: "adopted" });
  expect(f.allocation()).toMatchObject({ confirmed: true });
  expect(await f.retires(reopened)).toBe(true);
});

it("a confirmed allocation whose original is still unsettled stays fenced until the operator adopts it", async () => {
  // The durable state an adoption that confirmed before settling could leave behind.
  const f = await fixture(true);
  const store = f.open();
  expect(await f.retires(store)).toBe(false);
  // The refusal names the exact original to settle (VUH-2920), not just that one exists.
  await expect(store.retirementGuard(f.agent)).rejects.toThrow(
    `Settle original native hire receipt ${f.receiptId} before retiring its unconfirmed pane: settle_hire_receipt ${f.receiptId} adopt`,
  );
  // Auto-tidy leaves it to the operator; it adopts only an unconfirmed allocation.
  expect(await store.adoptUnconfirmedForTidy(f.agent, f.owner, async () => {})).toBeUndefined();
  expect(await store.settleHireReceipt(f.receiptId, async () => {}, "adopt")).toMatchObject({
    state: "adopted",
  });
  expect(await f.retires(store)).toBe(true);
});
