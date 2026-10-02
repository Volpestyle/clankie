import { describe, expect, it, vi } from "vitest";
import type { BrowserToolDescriptor } from "@clankie/protocol";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { browserExtension } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { runBrowserCommand } from "../../tui/src/command/browser.ts";

const descriptors: BrowserToolDescriptor[] = [
  {
    name: "browser_use_javascript",
    description: "Native JavaScript",
    inputSchema: { type: "object" },
    requiresShell: true,
    requiresApproval: false,
    riskClass: "reversible-write",
  },
  {
    name: "browser_use_read",
    description: "Read page",
    inputSchema: { type: "object" },
    requiresApproval: false,
    riskClass: "read",
  },
];
const catalog = async () => ({ schemaVersion: 1 as const, available: true, tools: descriptors });

describe("browser machine authority", () => {
  it.each([false, true])("filters Pi discovery and search for shell=%s", async (shell) => {
    const registered = new Map<string, ToolDefinition>();
    let active: string[] = [];
    let start: (() => void) | undefined;
    const call = vi.fn(async () => ({ outcome: "ok", content: "result", artifacts: [] }));
    const extension = browserExtension({ browser: { catalog, call } } as unknown as CaptainDeps, { shell });
    if (typeof extension === "function") throw new Error("named extension expected");
    await extension.factory({
      registerTool: (tool: ToolDefinition) => {
        registered.set(tool.name, tool);
        active.push(tool.name);
      },
      on: (_event: string, handler: () => void) => {
        start = handler;
      },
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
      },
    } as unknown as ExtensionAPI);
    start?.();
    expect(registered.has("browser_browser_use_javascript")).toBe(shell);
    const search = registered.get("browser_tool_search")!;
    await search.execute("search", { query: "javascript" }, undefined, undefined, {} as never);
    expect(active.includes("browser_browser_use_javascript")).toBe(shell);
    await registered.get("browser_browser_use_read")!.execute("read", {}, undefined, undefined, {} as never);
    expect(call).toHaveBeenLastCalledWith(expect.anything(), undefined, { shell });
  });

  it("keeps captain bearers browser-only and gives the CLI operator access", async () => {
    const call = vi.fn(async (request) => ({
      outcome: "ok" as const,
      tool: request.tool,
      content: "42",
      isError: false,
      artifacts: [],
    }));
    const app = await createClankieApp({
      captain: createStubCaptain(),
      browserTools: { catalog, call },
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === "Bearer social" ? { captainId: "social" } : undefined,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    });
    try {
      const listed = await app.app.request("/v1/browser/tools", {
        headers: { authorization: "Bearer social" },
      });
      expect((await listed.json()).catalog.tools.map((tool: BrowserToolDescriptor) => tool.name)).toEqual([
        "browser_use_read",
      ]);
      const refused = await app.app.request("/v1/browser/call", {
        method: "POST",
        headers: { authorization: "Bearer social", "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          tool: "browser_use_javascript",
          arguments: { code: "process.exit()", shell: true },
        }),
      });
      expect((await refused.json()).result).toMatchObject({
        outcome: "refused",
        reason: "approval_required",
      });
      expect(call).not.toHaveBeenCalled();
      const cli = {
        host: "http://localhost",
        env: { CLANKIE_OPERATOR_TOKEN: "owner" },
        fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
      };
      expect(await runBrowserCommand(["tools"], cli)).toMatchObject({ tools: descriptors });
      expect(
        await runBrowserCommand(["call", "browser_use_javascript", '{"code":"console.log(42)"}'], cli),
      ).toMatchObject({ outcome: "ok", content: "42" });
      expect(call).toHaveBeenLastCalledWith(
        expect.objectContaining({ arguments: { code: "console.log(42)" } }),
        expect.any(AbortSignal),
        { shell: true },
      );
    } finally {
      app.close();
    }
  });
});
