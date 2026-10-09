import { describe, expect, it } from "vitest";
import { FleetSeatToolCatalogSchema } from "@clankie/protocol/tool-catalog";
import { codexToolCatalogReport } from "../../../integrations/claude-plugin/worker/bin/codex-tool-catalog.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Native Codex 0.160.0 wire goldens: the original-thread inventory is data:[];
// MCP status stores tools by each raw tool.name, not its model-visible prefix.
// Sources: codex-rs/app-server/src/request_processors/mcp_processor.rs and
// codex-rs/codex-mcp/src/mcp/mod.rs at the rust-v0.160.0 tag.
const connected = {
  name: "clankie",
  runtimeStatus: "connected",
  toolsError: null,
  tools: { message_clankie: { name: "message_clankie", inputSchema: { type: "object" } } },
};

function runHook(path: string, env: NodeJS.ProcessEnv, hook: Record<string, unknown>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(hook));
  });
}

describe("Codex original native startup catalog", () => {
  it("keeps unbound owner interactive panes silent, including linked panes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-unbound-operator-"));
    const path = join(import.meta.dirname, "../../../integrations/codex-plugin/hooks/run.mjs");
    const env = {
      ...process.env,
      CLANKIE_STATE: root,
      HERDR_PANE_ID: "w1:p2",
      HERDR_SOCKET_PATH: "/tmp/operator-test.sock",
      CLANKIE_CODEX_SEAT_BINDING: "",
    };
    const hook = { hook_event_name: "SessionStart", session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
    try {
      await mkdir(join(root, "links"));
      await writeFile(
        join(root, "links/test.json"),
        JSON.stringify({
          schemaVersion: 2,
          authentication: "local-process",
          fleet: "test",
          socket: env.HERDR_SOCKET_PATH,
          url: "http://127.0.0.1:1",
        }),
      );
      const linked = await runHook(path, env, hook);
      expect(linked.code, linked.stderr).toBe(0);
      expect(linked).toEqual({ code: 0, stdout: "", stderr: "" });
      for (const [targetEnv, event] of [
        [{ ...env, HERDR_SOCKET_PATH: "/tmp/unlinked.sock" }, hook],
        [env, { ...hook, hook_event_name: "UserPromptSubmit" }],
        [env, { ...hook, agent_id: "child" }],
      ] as const) {
        const silent = await runHook(path, targetEnv, event);
        expect(silent).toEqual({ code: 0, stdout: "", stderr: "" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([200, 503])(
    "keeps installed Codex startup diagnostics out of the pane (catalog HTTP %s)",
    async (status) => {
      const root = await mkdtemp(join(tmpdir(), "codex-startup-catalog-"));
      const pluginRoot = join(import.meta.dirname, "../../../integrations/claude-plugin/worker");
      const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
      const hooks = JSON.parse(await readFile(join(pluginRoot, manifest.hooks), "utf8"));
      expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain("process.env.PLUGIN_ROOT");
      expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain("--codex");
      const received: unknown[] = [];
      const verdict = {
        status: "unverified",
        detail: "No original native endpoint.",
        remediation: "Ask Clankie to launch this work with hire_agent.",
      };
      const listener = createServer(async (request, response) => {
        let input = "";
        for await (const chunk of request) input += chunk;
        if (request.url?.endsWith("/tool-catalog")) received.push(JSON.parse(input));
        if (request.url?.endsWith("/tool-catalog")) response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.url?.endsWith("/tool-catalog") ? verdict : {}));
      });
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("No catalog listener");
      try {
        await mkdir(join(root, "links"));
        await writeFile(
          join(root, "links/test.json"),
          JSON.stringify({
            schemaVersion: 2,
            authentication: "local-process",
            fleet: "test",
            socket: "/tmp/catalog-test.sock",
            url: `http://127.0.0.1:${address.port}`,
          }),
        );
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(hooks.hooks.SessionStart[0].hooks[0].command, {
              shell: true,
              env: {
                ...process.env,
                PLUGIN_ROOT: pluginRoot,
                CLANKIE_STATE: root,
                HERDR_PANE_ID: "w1:p2",
                HERDR_SOCKET_PATH: "/tmp/catalog-test.sock",
                CLANKIE_CODEX_CATALOG_OBSERVED: "",
              },
              stdio: ["pipe", "pipe", "pipe"],
            });
            let stdout = "",
              stderr = "";
            child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, stdout, stderr }));
            child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "original" }));
          },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(received).toHaveLength(1);
        expect(FleetSeatToolCatalogSchema.parse(received[0])).toMatchObject({
          harness: "codex",
          sessionId: "original",
          bridge: "worker",
          tools: [],
          error: expect.stringContaining("no native catalog endpoint"),
        });
        // Even an older service's re-hire remediation must not steer the pane.
        expect(result.stdout).toBe("");
        if (status === 200) expect(result.stderr).toBe("");
        else expect(result.stderr).toContain("Codex catalog report answered 503");
        expect(result.stderr).not.toMatch(/rehire|hire_agent/);
      } finally {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("reports embedded sessions as unverified without opening another runtime", async () => {
    const report = await codexToolCatalogReport({ sessionId: "original", bridge: "worker" });
    expect(FleetSeatToolCatalogSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({ harness: "codex", sessionId: "original", tools: [] });
    expect(report.error).toContain("no native catalog endpoint");
    expect(report.error).toContain("Advisory:");
    expect(report.error).toContain("Continue the assignment with your current lead");
    expect(report.error).not.toContain("hire_agent");
  });

  it("reads the original loaded thread, exact Clankie server, and all native pages", async () => {
    const reads: { method: string; params: Record<string, unknown> }[] = [];
    const report = await codexToolCatalogReport({
      sessionId: "original",
      request: async (method, params) => {
        reads.push({ method, params });
        if (method === "thread/loaded/list") return { data: ["original", "other"] };
        return params.cursor === "next"
          ? { data: [connected], nextCursor: null }
          : { data: [{ ...connected, name: "another_server" }], nextCursor: "next" };
      },
    });
    expect(report.error).toBeUndefined();
    expect(report.tools).toEqual(["message_clankie"]);
    expect(reads).toEqual([
      { method: "thread/loaded/list", params: {} },
      {
        method: "mcpServerStatus/list",
        params: { threadId: "original", detail: "toolsAndAuthOnly" },
      },
      {
        method: "mcpServerStatus/list",
        params: { threadId: "original", detail: "toolsAndAuthOnly", cursor: "next" },
      },
    ]);
    expect(FleetSeatToolCatalogSchema.safeParse(report).success).toBe(true);
  });

  it("refuses an endpoint that has not loaded the pane's original session", async () => {
    const reads: string[] = [];
    const report = await codexToolCatalogReport({
      sessionId: "original",
      request: async (method) => {
        reads.push(method);
        return { data: ["independent-observer"] };
      },
    });
    expect(report.error).toContain("Original Codex thread is not loaded");
    expect(reads).toEqual(["thread/loaded/list"]);
  });

  it.each([
    { data: [] },
    { data: [{ ...connected, runtimeStatus: "failed" }] },
    { data: [{ ...connected, toolsError: 'tools[4].inputSchema.type expected "object"' }] },
  ])("reports a proven dropped server as accepting no Clankie tools: %j", async (status) => {
    const report = await codexToolCatalogReport({
      sessionId: "original",
      request: async (method) => (method === "thread/loaded/list" ? { data: ["original"] } : status),
    });
    expect(report.tools).toEqual([]);
    // The health store can compare a proven empty list to the bridge bank.
    expect(report.error).toBeUndefined();
  });

  it.each([
    { data: [connected, connected] },
    { data: [{ ...connected, runtimeStatus: "starting" }] },
    { data: [connected], nextCursor: "same" },
    { data: [{ ...connected, tools: [] }] },
  ])("keeps ambiguous, pending, and malformed native observations unverified: %j", async (status) => {
    const report = await codexToolCatalogReport({
      sessionId: "original",
      request: async (method) => (method === "thread/loaded/list" ? { data: ["original"] } : status),
    });
    expect(report.error).toBeTruthy();
    expect(report.tools).toEqual([]);
  });
});

it.each(["clankie", "worker"])("resolves the %s worker registration through the update", async (name) => {
  const report = await codexToolCatalogReport({
    sessionId: "original",
    request: async (method: string) =>
      method === "thread/loaded/list"
        ? { data: ["original"] }
        : { data: [{ ...connected, name }], nextCursor: null },
  });
  expect(report.error).toBeUndefined();
  expect(report.tools).toContain("message_clankie");
});
