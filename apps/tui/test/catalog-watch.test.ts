import { expect, it, vi } from "vitest";
import { createCatalogWatcher } from "../../../integrations/claude-plugin/worker/bin/catalog-watch.mjs";

const tool = (name: string, description = name) => ({ name, description, inputSchema: { type: "object" } });
it("notifies additions, removals and schema changes, without notifying a reordered catalog", async () => {
  let tools = [tool("one"), tool("two")];
  const notify = vi.fn(async () => {});
  const watcher = createCatalogWatcher({ list: async () => tools, notify });
  watcher.observe(tools);
  tools = [tool("two"), tool("one")];
  await watcher.check();
  expect(notify).not.toHaveBeenCalled();
  tools = [...tools, tool("new")];
  await watcher.check();
  tools = [tool("one", "new description")];
  await watcher.check();
  tools = [];
  await watcher.check();
  expect(notify).toHaveBeenCalledTimes(3);
});

it("keeps the last advertised catalog on a failed read and coalesces notifications during discovery", async () => {
  let resolve!: (tools: ReturnType<typeof tool>[]) => void;
  const list = vi.fn(
    () =>
      new Promise<ReturnType<typeof tool>[]>((done) => {
        resolve = done;
      }),
  );
  const notify = vi.fn(async () => {});
  const watcher = createCatalogWatcher({ list, notify });
  watcher.observe([tool("message")]);
  const a = watcher.check(),
    b = watcher.check();
  expect(list).toHaveBeenCalledTimes(1);
  resolve([tool("message"), tool("new")]);
  await Promise.all([a, b]);
  expect(notify).toHaveBeenCalledTimes(1);
  list.mockRejectedValueOnce(new Error("service restarted"));
  await expect(watcher.check()).rejects.toThrow("service restarted");
  expect(notify).toHaveBeenCalledTimes(1);
  const next = watcher.check();
  resolve([]);
  await next;
  expect(notify).toHaveBeenCalledTimes(2);
});
