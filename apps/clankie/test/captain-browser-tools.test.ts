import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { browserExtension } from "../src/captain/tools.ts";

describe("captain browser tools", () => {
  it("delivers a useful preview of a large browser page to the model", async () => {
    const tools = new Map<string, ToolDefinition>();
    const page = {
      outcome: "ok",
      tool: "agent_browser_read",
      content: "# Browser documentation\nUseful page content.\n".repeat(2000),
      isError: false,
      artifacts: [],
    };
    const deps = {
      browser: {
        catalog: async () => ({
          available: true,
          tools: [descriptor("agent_browser_read", "Read a page")],
        }),
        call: async () => page,
      },
    } as unknown as CaptainDeps;
    const extension = browserExtension(deps, {});
    if (typeof extension === "function") throw new Error("named extension expected");
    await extension.factory({
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      on: () => {},
    } as unknown as ExtensionAPI);
    const read = tools.get("browser_agent_browser_read");
    if (read === undefined) throw new Error("browser_agent_browser_read is missing");

    const result = await read.execute("large-page", {}, undefined, undefined, {} as never);
    const text = result.content.find((block) => block.type === "text")?.text ?? "";
    expect(text).toContain("# Browser documentation");
    expect(text).toContain("Useful page content.");
    expect(text).toContain("[Output truncated to 51200 of ");
    expect(result.details).toBe(page);
  });

  it("registers the full catalog but activates uncommon tools only after search", async () => {
    const tools = new Map<string, ToolDefinition>();
    let active = ["remember_episode"];
    let start: (() => void) | undefined;
    const api = {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
        active.push(tool.name);
      },
      on(event: string, handler: () => void) {
        if (event === "session_start") start = handler;
      },
      getActiveTools: () => active,
      setActiveTools(names: string[]) {
        active = names;
      },
    } as unknown as ExtensionAPI;
    const deps = {
      browser: {
        catalog: () =>
          Promise.resolve({
            schemaVersion: 1 as const,
            available: true,
            tools: [
              descriptor("agent_browser_open", "Open a page"),
              descriptor("agent_browser_console", "Read console errors"),
            ],
          }),
        call: () => Promise.reject(new Error("unused")),
      },
    } as unknown as CaptainDeps;

    const extension = browserExtension(deps, {});
    if (typeof extension === "function") throw new Error("named extension expected");
    await extension.factory(api);
    start?.();

    expect([...tools]).toHaveLength(3);
    expect(active).toEqual(["remember_episode", "browser_tool_search", "browser_agent_browser_open"]);
    const search = tools.get("browser_tool_search");
    if (search === undefined) throw new Error("browser_tool_search is missing");
    await search.execute("call-1", { query: "console errors" }, undefined, undefined, {} as never);
    expect(active).toContain("browser_agent_browser_console");
    expect(tools.get("browser_agent_browser_console")?.executionMode).toBe("sequential");
  });
});

function descriptor(name: string, description: string) {
  return {
    name,
    description,
    inputSchema: { type: "object" },
    riskClass: "read" as const,
    requiresApproval: false,
  };
}
