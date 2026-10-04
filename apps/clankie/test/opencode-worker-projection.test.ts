import { expect, test } from "vitest";
// @ts-expect-error Standalone native plugin module.
import ClankieNativeWorker from "../../../integrations/opencode-plugin/worker-server.mjs";

test("worker projection removes inherited personal tracker routes and preserves other native requirements", async () => {
  const config = {
    model: "fixture/native",
    permission: { bash: "ask" },
    mcp: {
      clankie: { type: "local", command: ["clankie", "mcp", "--seat"], enabled: true },
      linear: { type: "remote", url: "https://example.invalid" },
      tasks: { type: "remote", url: "https://mcp.linear.app/mcp" },
      localTasks: { type: "local", command: ["npx", "@linear/mcp"] },
      docs: { type: "local", command: ["docs-mcp"], enabled: true },
    },
  };
  const plugin = await ClankieNativeWorker();
  await plugin.config(config);
  expect(config).toEqual({
    model: "fixture/native",
    permission: { bash: "ask" },
    mcp: {
      clankie: { type: "local", command: ["clankie", "mcp", "--fleet"], enabled: true },
      linear: { enabled: false },
      tasks: { enabled: false },
      localTasks: { enabled: false },
      docs: { type: "local", command: ["docs-mcp"], enabled: true },
    },
  });
});
