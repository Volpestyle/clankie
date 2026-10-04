import { expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createConnectedLinearFixture, heldProviderWrite } from "./fixtures/linear-connected-mcp.ts";

function result(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  const host = JSON.parse((result.content as { text: string }[])[0]!.text) as {
    outcome: string;
    content: string;
    isError: boolean;
  };
  expect(host.outcome).toBe("ok");
  expect(host.isError).toBe(false);
  return JSON.parse(host.content) as Record<string, unknown>;
}

it("six serial connected Linear state writes retain receipts and attribution without induced transport faults", async () => {
  const f = await createConnectedLinearFixture();
  try {
    console.info(
      `Connected Linear fixture work-owner attribution: ${f.attributionAvailable ? "runtime production helper + actual ConversationStore" : "unavailable on this source base; revision receipts only"}`,
    );
    const pid = f.pid();
    expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["linear_save_issue", "linear_save_comment", "linear_list_issues"]),
    );
    for (let iteration = 0; iteration < 6; iteration++) {
      const saved = result(
        await f.client.callTool({
          name: "linear_save_issue",
          arguments: { id: f.issueIdentifier, state: "Done" },
        }),
      );
      expect(saved).toMatchObject({ id: f.issueIdentifier, status: "Done" });
      const listed = result(await f.client.callTool({ name: "linear_list_issues", arguments: {} }));
      expect(listed.issues).toEqual([expect.objectContaining({ uuid: f.issueId, status: "Done" })]);
      const effects = await f.effects();
      expect(effects).toHaveLength(iteration + 1);
      expect(effects.at(-1)?.returned).toMatchObject({
        id: f.issueIdentifier,
        uuid: f.issueId,
        status: "Done",
      });
      if (f.attributionAvailable)
        expect(await f.owners()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              issueId: f.issueId,
              organizationId: f.organizationId,
              conversationId: f.conversationId,
            }),
          ]),
        );
    }
    const comment = result(
      await f.client.callTool({
        name: "linear_save_comment",
        arguments: { issueId: f.issueId, body: "Controlled fixture comment" },
      }),
    );
    expect(comment).toMatchObject({ id: expect.any(String), body: "Controlled fixture comment" });
    const effects = await f.effects();
    expect(effects.map((effect) => effect.tool)).toEqual([
      ...Array.from({ length: 6 }, () => "save_issue"),
      "save_comment",
    ]);
    // Display-ID issue results retain their canonical UUID receipt alongside comments.
    expect(await f.revisions()).toHaveLength(7);
    expect(f.logs().filter((log) => log.event === "mcp.host.call" && log.tool === "save_issue")).toHaveLength(
      6,
    );
    expect(f.logs().some((log) => log.event === "mcp.host.observer_failed")).toBe(false);
    expect(f.sessions()).toEqual({ provider: 1, lane: 1 });
    expect(f.closed()).toBe(false);
    expect(f.pid()).toBe(pid);
  } finally {
    await f.close();
  }
});

it.each(["save_issue", "save_comment"] as const)(
  "an admitted connected %s receipt survives an explicitly dropped notification stream and catalog refresh",
  async (tool) => {
    const held = heldProviderWrite(tool);
    const f = await createConnectedLinearFixture({ channel: true, heldWrite: held });
    try {
      const pid = f.pid();
      await f.channelReady;
      expect(await f.wake()).toMatchObject({ outcome: "delivered" });
      const write = f.client
        .callTool({
          name: `linear_${tool}`,
          arguments:
            tool === "save_issue"
              ? { id: f.issueIdentifier, state: "Done" }
              : { issueId: f.issueId, body: "Held controlled comment" },
        })
        .then(
          (receipt) => ({ receipt }),
          (error: unknown) => ({
            error,
            hostCompletedAtCallerFailure: f
              .logs()
              .some((log) => log.event === "mcp.host.call" && log.tool === tool),
          }),
        );
      await held.admitted.promise;
      expect(await f.effects()).toHaveLength(1);
      expect(f.logs().some((log) => log.event === "mcp.host.call" && log.tool === tool)).toBe(false);
      await f.dropNotificationStream();
      expect((await f.client.listTools()).tools.map((entry) => entry.name)).toContain(`linear_${tool}`);
      expect(f.sessions()).toEqual({ provider: 1, lane: 2 });
      const retired = await f.waitForTransportEvent((event) => event.event === "upstream_retired");
      expect(retired).toMatchObject({ generation: 1, retired: true, closing: false });
      expect(retired.pending).toBeGreaterThan(0);
      expect(
        f
          .transportEvents()
          .some((event) => event.event === "upstream_closed" && event.generation === retired.generation),
      ).toBe(false);
      held.response.release();
      await held.observed.promise;
      const settled = await write;
      expect(await f.effects()).toHaveLength(1);
      expect(await f.revisions()).toHaveLength(1);
      expect(f.closed()).toBe(false);
      expect(f.pid()).toBe(pid);
      if (f.attributionAvailable)
        expect(await f.owners()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ issueId: f.issueId, conversationId: f.conversationId }),
          ]),
        );
      expect(
        settled,
        `One provider effect; attribution completed; stdio PID unchanged and open. Host completed at caller failure: ${"hostCompletedAtCallerFailure" in settled ? String(settled.hostCompletedAtCallerFailure) : "no caller failure"}`,
      ).not.toHaveProperty("error");
      if (!("receipt" in settled)) throw new Error("Connected write lost its native receipt");
      const saved = result(settled.receipt);
      expect(
        await f.waitForTransportEvent(
          (event) => event.event === "upstream_closed" && event.generation === retired.generation,
        ),
      ).toMatchObject({ pending: 0, retired: true, closing: true });
      expect(saved).toMatchObject(
        tool === "save_issue"
          ? { id: f.issueIdentifier, status: "Done" }
          : { body: "Held controlled comment" },
      );
      expect(result(await f.client.callTool({ name: "linear_list_issues", arguments: {} })).issues).toEqual([
        expect.objectContaining({
          uuid: f.issueId,
          status: tool === "save_issue" ? "Done" : "In Progress",
        }),
      ]);
    } finally {
      await f.close();
    }
  },
);
