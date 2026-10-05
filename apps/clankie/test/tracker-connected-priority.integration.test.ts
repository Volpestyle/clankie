import { expect, it } from "vitest";
import { createConnectedLinearFixture } from "./fixtures/linear-connected-mcp.ts";

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
      const host = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(host).toMatchObject({ outcome: "ok", isError: false });
      return JSON.parse(host.content);
    };
    const first = await call({ state: "unstarted", limit: 2 });
    expect(first.issues.map((issue: { id: string }) => issue.id)).toEqual(["FIXTURE-URGENT", "FIXTURE-HIGH"]);
    expect(first.hasNextPage).toBe(true);
    const second = await call({ state: "unstarted", limit: 2, cursor: first.cursor });
    expect(second.issues.map((issue: { id: string }) => issue.id)).toEqual(["FIXTURE-LOW", "FIXTURE-NONE"]);
    expect(second.hasNextPage).toBe(false);
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
