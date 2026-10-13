import { afterEach, expect, it, vi } from "vitest";
import { createDeliverableProjectReader } from "../src/fleet-project-deliverable.ts";
import type { McpHost } from "../src/mcp-host.ts";
const projectId = "bdfa8c5a-933d-4f59-abf7-db42f81e45d1";
const issue = (identifier = "VUH-2192", project = projectId) => ({
  outcome: "ok" as const,
  isError: false,
  content: JSON.stringify({ identifier, projectId: project }),
});
afterEach(() => vi.useRealTimers());
it("coalesces exact recorded deliverables through verified background reads", async () => {
  const call = vi.fn<McpHost["call"]>().mockResolvedValue(issue());
  const read = createDeliverableProjectReader({ call });
  expect(await Promise.all([read("Own VUH-2192"), read("VUH-2192")])).toEqual([projectId, projectId]);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0]![0]).toMatchObject({
    lane: "operator",
    server: "linear",
    tool: "get_issue",
    arguments: { id: "VUH-2192" },
    resultMode: "data",
    requestPriority: "background",
  });
});
it("keeps ambiguous deliverables, unrelated responses and missing tracker projects unknown", async () => {
  const call = vi.fn<McpHost["call"]>().mockResolvedValue(issue("VUH-9999"));
  const read = createDeliverableProjectReader({ call });
  expect(await read("Own VUH-2192 and VUH-2183")).toBeUndefined();
  expect(await read("/Users/james/dev/clankie")).toBeUndefined();
  expect(call).not.toHaveBeenCalled();
  expect(await read("VUH-2192")).toBeUndefined();
  call.mockResolvedValue(issue("VUH-2183", "Clankie"));
  expect(await read("VUH-2183")).toBeUndefined();
});
it("limits concurrent provider reads and retries unknown results after a bounded cache lifetime", async () => {
  vi.useFakeTimers();
  const settlers: Array<(value: Awaited<ReturnType<McpHost["call"]>>) => void> = [];
  const call = vi.fn<McpHost["call"]>().mockImplementation(
    () =>
      new Promise((resolve) => {
        settlers.push(resolve);
      }),
  );
  const read = createDeliverableProjectReader({ call });
  const first = read("VUH-2192");
  const second = read("VUH-2183");
  expect(await read("VUH-2029")).toBeUndefined();
  expect(call).toHaveBeenCalledTimes(2);
  settlers[0]!(issue());
  settlers[1]!(issue("VUH-2183"));
  expect(await first).toBe(projectId);
  expect(await second).toBe(projectId);
  // A failed read has the same bounded lifetime as a successful observation.
  call.mockResolvedValue({ outcome: "ok", isError: true, content: "{}" });
  expect(await read("VUH-2029")).toBeUndefined();
  expect(await read("VUH-2029")).toBeUndefined();
  expect(call).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(60_000);
  call.mockResolvedValue(issue("VUH-2029"));
  expect(await read("VUH-2029")).toBe(projectId);
});
