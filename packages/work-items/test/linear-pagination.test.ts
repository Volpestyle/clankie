import { expect, it, vi } from "vitest";
import { createLinearBackend } from "../src/backends/linear.ts";

const issue = (id: number, statusType = "started") => ({ id: `VUH-${id}`, title: `Item ${id}`, statusType });

it("pages in bounded chunks and honors the overall limit", async () => {
  const call = vi.fn(async (_tool: string, args: Record<string, unknown>) => {
    const offset = args.cursor === undefined ? 0 : Number(args.cursor);
    return {
      issues: Array.from({ length: Number(args.limit) }, (_, i) => issue(offset + i)),
      hasNextPage: true,
      cursor: String(offset + Number(args.limit)),
    };
  });
  const items = await createLinearBackend({ team: "VUH", project: "Clankie", call }).list({ limit: 120 });
  expect(items).toHaveLength(120);
  expect(items.at(-1)?.id).toBe("VUH-119");
  expect(call.mock.calls.map(([, args]) => ({ limit: args.limit, cursor: args.cursor }))).toEqual([
    { limit: 50, cursor: undefined },
    { limit: 50, cursor: "50" },
    { limit: 20, cursor: "100" },
  ]);
  for (const [tool, args] of call.mock.calls)
    expect({ tool, team: args.team, project: args.project }).toEqual({
      tool: "list_issues",
      team: "VUH",
      project: "Clankie",
    });
});

it("continues across filtered-out pages and stops when the server is exhausted", async () => {
  const call = vi.fn(async (_tool: string, args: Record<string, unknown>) =>
    args.cursor === undefined
      ? { issues: [issue(1, "completed")], hasNextPage: true, cursor: "next" }
      : { issues: [issue(2)], hasNextPage: false },
  );
  const items = await createLinearBackend({ team: "VUH", call }).list({ status: ["in_progress"], limit: 5 });
  expect(items.map((item) => item.id)).toEqual(["VUH-2"]);
  expect(call).toHaveBeenCalledTimes(2);
});

it.each([undefined, "same"])("rejects a missing or repeated continuation cursor (%s)", async (cursor) => {
  const call = vi.fn(async () => ({ issues: [], hasNextPage: true, cursor }));
  await expect(createLinearBackend({ team: "VUH", call }).list()).rejects.toMatchObject({
    code: "invalid_pagination",
  });
  expect(call.mock.calls.length).toBeLessThanOrEqual(2);
});
