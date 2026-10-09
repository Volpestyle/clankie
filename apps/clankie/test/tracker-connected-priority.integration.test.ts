import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import { expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createConnectedLinearFixture,
  heldProviderRead,
  heldProviderWrite,
} from "./fixtures/linear-connected-mcp.ts";

type Fixture = Awaited<ReturnType<typeof createConnectedLinearFixture>>;
type Listing = { issues: { id: string; status?: string }[]; cursor?: string; hasNextPage?: boolean };

async function hostResult(f: Fixture, name: string, args: Record<string, unknown> = {}) {
  const result = await f.client.callTool({ name: `linear_${name}`, arguments: args });
  if (result.isError) {
    const content = (result.content as { text: string }[])[0]!.text;
    return { outcome: "tool_error", isError: true, content };
  }
  return decodeMcpResult(result) as {
    outcome: string;
    isError?: boolean;
    content?: unknown;
    detail?: string;
  };
}

async function list(f: Fixture, args: Record<string, unknown> = {}): Promise<Listing> {
  const result = await hostResult(f, "list_issues", args);
  expect(result).toMatchObject({ outcome: "ok", isError: false });
  return (typeof result.content === "string" ? JSON.parse(result.content) : result.content) as Listing;
}

function providerPages() {
  return Array.from({ length: 4 }, (_, page) =>
    Array.from({ length: 250 }, (_, row) => ({
      id: `FIXTURE-${page * 250 + row}`,
      priority: 1 + ((page * 250 + row) % 4),
      status: "Todo",
    })),
  );
}

it("sorts open connected work across provider pages before exposing canonical cursor pages", async () => {
  const f = await createConnectedLinearFixture({
    priorityPages: [
      [
        { id: "FIXTURE-LOW", priority: 4, status: "Todo" },
        { id: "FIXTURE-NONE", priority: 0, status: "Todo" },
      ],
      [
        { id: "FIXTURE-URGENT", priority: { value: 1, name: "Urgent" }, status: "Todo" },
        { id: "FIXTURE-HIGH", priority: 2, status: "Todo" },
      ],
    ],
  });
  try {
    const call = async (args: Record<string, unknown>) => {
      const result = await f.client.callTool({ name: "linear_list_issues", arguments: args });
      expect(result.isError).not.toBe(true);
      const host = decodeMcpResult(result) as { outcome: string; isError: boolean; content: unknown };
      expect(host).toMatchObject({ outcome: "ok", isError: false });
      return typeof host.content === "string" ? JSON.parse(host.content) : host.content;
    };
    const first = await call({ state: "unstarted", limit: 2 });
    expect(first.issues.map((issue: { id: string }) => issue.id)).toEqual(["FIXTURE-URGENT", "FIXTURE-HIGH"]);
    expect(first.hasNextPage).toBe(true);
    const second = await call({ state: "unstarted", limit: 2, cursor: first.cursor });
    expect(second.issues.map((issue: { id: string }) => issue.id)).toEqual(["FIXTURE-LOW", "FIXTURE-NONE"]);
    expect(second.hasNextPage).toBe(false);
    expect(f.providerReads()).toHaveLength(2);
    const selected = await call({ state: "unstarted", fields: ["id"], limit: 2 });
    expect(selected.issues.map((issue: { id: string }) => issue.id)).toEqual([
      "FIXTURE-URGENT",
      "FIXTURE-HIGH",
    ]);
    expect(
      (await call({ state: "unstarted", orderBy: "updatedAt", limit: 2 })).issues.map(
        (issue: { id: string }) => issue.id,
      ),
    ).toEqual(["FIXTURE-URGENT", "FIXTURE-HIGH"]);
    expect(await f.effects()).toEqual([]);
  } finally {
    await f.close();
  }
});

it("reuses one provider snapshot for 46 immediate polls with five logical pages each", async () => {
  const f = await createConnectedLinearFixture({ priorityPages: providerPages() });
  try {
    let expected: string[] | undefined;
    for (let poll = 0; poll < 46; poll++) {
      let cursor: string | undefined;
      const ids: string[] = [];
      for (let page = 0; page < 5; page++) {
        const result = await list(f, { limit: 50, ...(cursor ? { cursor } : {}) });
        expect(result.issues).toHaveLength(50);
        ids.push(...result.issues.map((issue) => issue.id));
        cursor = result.cursor;
      }
      expected ??= ids;
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(250);
    }
    expect(f.providerReads()).toHaveLength(4);
    await mkdir(".local/linear-read-polling", { recursive: true });
    await writeFile(
      ".local/linear-read-polling/after-provider.json",
      JSON.stringify(
        {
          transport: "real MCP SDK HTTP provider and stdio consumer; fixture only",
          polls: 46,
          cadence: "immediate; simulated cache clock unchanged",
          logicalPagesPerPoll: 5,
          logicalCalls: 230,
          providerPagesPerScan: 4,
          providerCalls: f.providerReads().length,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await f.close();
  }
});

it("coalesces concurrent SDK readers while the first provider page is held", async () => {
  const held = heldProviderRead();
  const f = await createConnectedLinearFixture({ priorityPages: providerPages(), heldRead: held });
  try {
    const readers = Promise.all(Array.from({ length: 12 }, () => list(f, { limit: 50 })));
    await held.admitted.promise;
    expect(f.providerReads()).toHaveLength(1);
    held.response.release();
    const pages = await readers;
    expect(pages.every((page) => page.issues.length === 50)).toBe(true);
    expect(pages.every((page) => page.cursor === pages[0]!.cursor)).toBe(true);
    expect(f.providerReads()).toHaveLength(4);
  } finally {
    held.response.release();
    await f.close();
  }
});

it("invalidates at mutation dispatch and settlement, signed webhooks, and success expiry", async () => {
  const held = heldProviderWrite("save_issue");
  const f = await createConnectedLinearFixture({ priorityReads: true, heldWrite: held });
  try {
    expect((await list(f)).issues[0]?.status).toBe("In Progress");
    const write = hostResult(f, "save_issue", { id: f.issueIdentifier, state: "Done" });
    await held.admitted.promise;
    expect((await list(f)).issues[0]?.status).toBe("Done");
    expect(f.providerReads()).toHaveLength(2);
    held.response.release();
    expect(await write).toMatchObject({ outcome: "ok", isError: false });
    await held.observed.promise;
    expect((await list(f)).issues[0]?.status).toBe("Done");
    expect(f.providerReads()).toHaveLength(3);

    f.updateProviderIssue("Todo");
    expect((await f.signedWebhook(false)).status).toBe(401);
    expect((await list(f)).issues[0]?.status).toBe("Done");
    expect(f.providerReads()).toHaveLength(3);
    expect((await f.signedWebhook()).status).toBe(200);
    expect((await list(f)).issues[0]?.status).toBe("Todo");
    expect(f.providerReads()).toHaveLength(4);

    f.advanceReadClock(60_001);
    await list(f);
    expect(f.providerReads()).toHaveLength(5);
    expect(await f.effects()).toHaveLength(1);
  } finally {
    held.response.release();
    await f.close();
  }
});

it("fences cursor snapshots across credential generations and signed external updates", async () => {
  const f = await createConnectedLinearFixture({ priorityPages: providerPages() });
  try {
    const first = await list(f, { limit: 50 });
    await f.rotateCredential();
    expect(await hostResult(f, "list_issues", { limit: 50, cursor: first.cursor })).toMatchObject({
      outcome: "refused",
    });
    const current = await list(f, { limit: 50 });
    expect(f.providerReads()).toHaveLength(8);
    await f.rotateCredential("key");
    expect(await hostResult(f, "list_issues", { limit: 50, cursor: current.cursor })).toMatchObject({
      outcome: "refused",
    });
    const rotated = await list(f, { limit: 50 });
    expect(f.providerReads()).toHaveLength(12);
    expect((await f.signedWebhook()).status).toBe(200);
    expect(await hostResult(f, "list_issues", { limit: 50, cursor: rotated.cursor })).toMatchObject({
      outcome: "refused",
    });
    await list(f, { limit: 50 });
    expect(f.providerReads()).toHaveLength(16);
  } finally {
    await f.close();
  }
});

it("does not publish an in-flight snapshot after its connected credential is revoked", async () => {
  const held = heldProviderRead();
  const f = await createConnectedLinearFixture({ priorityReads: true, heldRead: held });
  try {
    const reading = hostResult(f, "list_issues");
    await held.admitted.promise;
    await f.disconnectCredential();
    held.response.release();
    expect(await reading).toMatchObject({ outcome: "refused" });
    expect(f.providerReads()).toHaveLength(1);
  } finally {
    held.response.release();
    await f.close();
  }
});

it("keeps provider failures in cooldown across repeated reads and webhook invalidation", async () => {
  const f = await createConnectedLinearFixture({ priorityReads: true });
  try {
    f.failNextRead();
    expect(await hostResult(f, "list_issues")).toMatchObject({ outcome: "tool_error", isError: true });
    for (let poll = 0; poll < 12; poll++)
      expect(await hostResult(f, "list_issues")).toMatchObject({ outcome: "tool_error", isError: true });
    expect(f.providerReads()).toHaveLength(1);
    expect((await f.signedWebhook()).status).toBe(200);
    expect(
      await hostResult(f, "save_comment", { issueId: f.issueId, body: "Keep the read cooldown" }),
    ).toMatchObject({
      outcome: "ok",
      isError: false,
    });
    f.advanceReadClock(29_999);
    expect(await hostResult(f, "list_issues")).toMatchObject({ outcome: "tool_error", isError: true });
    expect(f.providerReads()).toHaveLength(1);
    f.advanceReadClock(2);
    expect((await list(f)).issues).toHaveLength(1);
    expect(f.providerReads()).toHaveLength(2);
  } finally {
    await f.close();
  }
});
