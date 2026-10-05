/** Explicit, opt-in compatibility proof using visible native TUIs, never headless agents. */
import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { globSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  startCodexAppServerSeat,
  CodexAppServerClient,
  openCodexSocket,
} from "../src/captain/codex-app-server.ts";
import { readHerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";
import type { GrokNativeHost } from "../src/captain/grok-native-host.ts";

export async function verifyNativeMcp(input: {
  root: string;
  repoRoot: string;
  native: GrokNativeHost;
  env: NodeJS.ProcessEnv;
  ownerHome: string;
  observations: Array<Record<string, unknown>>;
}) {
  const { root, repoRoot, native, env, ownerHome, observations } = input;
  const result: Record<string, unknown> = {};
  const common = {
    command: join(root, "bin/clankie"),
    args: ["mcp", "--lane", "operator"],
    env: {
      CLANKIE_CONTROL_PLANE_URL: env.CLANKIE_CONTROL_PLANE_URL!,
      CLANKIE_OPERATOR_TOKEN: env.CLANKIE_OPERATOR_TOKEN!,
      CLANKIE_STATE: env.CLANKIE_STATE!,
      CLANKIE_STATE_HOME: env.CLANKIE_STATE_HOME!,
    },
  };
  const prompt =
    "This is an owner-authorized read-only MCP compatibility check. Use only Clankie's MCP tools. " +
    "Call recall_episodes with query VUH1583, then get_goal with empty arguments. " +
    "After both return, report their actual returned values and VUH1583_NATIVE_MCP_OK. " +
    "Do not write files, start agents, ask questions, or call any other tools.";
  const claudeId = randomUUID();
  const claudeConfig = join(root, "claude-mcp.json");
  // This first-turn check disables built-ins, including ToolSearch. Load the
  // test server eagerly rather than racing Claude's background/deferred catalog.
  // https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral
  await writeFile(
    claudeConfig,
    JSON.stringify({ mcpServers: { clankie: { ...common, alwaysLoad: true } } }),
    {
      mode: 0o600,
    },
  );
  // Equivalent to claude2: same existing alternate profile, no sign-in or account changes.
  const claudeProfile = join(ownerHome, ".claude-james");
  const claudeTranscript = () => {
    const path = globSync(join(claudeProfile, "projects/*", `${claudeId}.jsonl`))[0];
    return path
      ? readHerdrSeatTranscript("claude", { kind: "path", value: path, source: "herdr:claude" })
      : undefined;
  };
  const claudePane = await native.createCommandTab({
    cwd: repoRoot,
    label: "VUH1583 Claude MCP compatibility",
    command: [
      "claude",
      "--session-id",
      claudeId,
      "--strict-mcp-config",
      "--mcp-config",
      claudeConfig,
      "--setting-sources",
      "user",
      "--settings",
      JSON.stringify({ permissions: { allow: ["mcp__clankie__recall_episodes", "mcp__clankie__get_goal"] } }),
      "--tools",
      "",
      "--effort",
      "low",
      prompt,
    ],
    env: {
      ...env,
      HOME: ownerHome,
      CLAUDE_CONFIG_DIR: claudeProfile,
      MCP_CONNECTION_NONBLOCKING: "0",
      MCP_TIMEOUT: "30000",
    } as Record<string, string>,
  });
  result.claude = { pane: claudePane, sessionId: claudeId, accountProfile: "claude2" };
  const codexHome = join(root, "codex");
  await mkdir(codexHome, { mode: 0o700 });
  await copyFile(join(ownerHome, ".codex/auth.json"), join(codexHome, "auth.json"));
  await writeFile(
    join(codexHome, "config.toml"),
    `cli_auth_credentials_store = "file"\ndaemon_auto_start = false\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`,
    { mode: 0o600 },
  );
  let codexPane: string | undefined;
  const codexEvents: Array<Record<string, unknown>> = [];
  let codex: Awaited<ReturnType<typeof startCodexAppServerSeat>> | undefined;
  let codexPid: number | undefined;
  let reader: CodexAppServerClient | undefined;
  try {
    codex = await startCodexAppServerSeat({
      cwd: root,
      model: "gpt-6.1-sol",
      effort: "low",
      onServerStarted: (pid) => {
        codexPid = pid;
      },
      env: { ...env, CODEX_HOME: codexHome } as Record<string, string>,
      config: [
        `mcp_servers.clankie.command=${JSON.stringify(common.command)}`,
        `mcp_servers.clankie.args=${JSON.stringify(common.args)}`,
        `mcp_servers.clankie.env_vars=${JSON.stringify(Object.keys(common.env))}`,
        // Only the two owner-requested reads, in this disposable profile.
        'mcp_servers.clankie.tools.recall_episodes.approval_mode="approve"',
        'mcp_servers.clankie.tools.get_goal.approval_mode="approve"',
      ],
      threadStartTimeoutMs: 30_000,
      startView: async (args) => {
        codexPane = await native.createCommandTab({
          cwd: root,
          label: "VUH1583 Codex MCP compatibility",
          command: ["codex", ...args],
          env: { ...env, CODEX_HOME: codexHome } as Record<string, string>,
        });
      },
      onEvent: (event) => {
        if (["item/completed", "turn/completed"].includes(event.method) || event.method.startsWith("mcp"))
          codexEvents.push({ method: event.method, params: event.params });
      },
    });
    result.codex = { pane: codexPane, threadId: codex.threadId, dedicatedServer: true };
    assert.ok(codexPid);
    const endpoint = codex.viewArgs[codex.viewArgs.indexOf("--remote") + 1];
    assert.ok(endpoint && endpoint.startsWith("unix://"));
    const socketPath = endpoint.slice("unix://".length);
    const socket = await openCodexSocket(`ws+unix://${socketPath}:/`);
    assert.ok(socket);
    reader = new CodexAppServerClient(socket, () => {});
    await reader.initialize();
    const catalogDeadline = Date.now() + 25_000;
    while (true) {
      const catalog = (await reader.request("mcpServerStatus/list", {
        threadId: codex.threadId,
        detail: "toolsAndAuthOnly",
      })) as { data?: Array<{ name?: string; tools?: Record<string, unknown>; runtimeStatus?: string }> };
      result.codexCatalog = catalog.data?.map((row) => ({
        name: row.name,
        status: row.runtimeStatus,
        tools: Object.entries(row.tools ?? {}).map(([name, tool]) => ({
          name,
          schemaType: (tool as { inputSchema?: { type?: string } }).inputSchema?.type,
        })),
      }));
      if (
        catalog.data?.some(
          (row) =>
            row.name === "clankie" &&
            row.runtimeStatus === "connected" &&
            ["recall_episodes", "get_goal"].every((name) => Object.hasOwn(row.tools ?? {}, name)),
        )
      )
        break;
      if (Date.now() >= catalogDeadline)
        throw new Error(`Codex native catalog unavailable: ${JSON.stringify(result)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await codex.send(prompt);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const claude = claudeTranscript();
      const path =
        codex.transcriptPath ?? globSync(join(codexHome, "sessions/**/*", `*${codex.threadId}*.jsonl`))[0];
      const codexTranscript = path
        ? readHerdrSeatTranscript("codex", { kind: "path", value: path, source: "herdr:codex" })
        : undefined;
      const completed = (transcript: typeof claude) =>
        transcript?.entries.some(
          (entry) =>
            entry.type === "message" &&
            entry.role === "agent" &&
            entry.text.includes("VUH1583_NATIVE_MCP_OK") &&
            entry.text.includes("VUH1583_MEMORY_SENTINEL"),
        ) &&
        ["recall_episodes", "get_goal"].every((name) =>
          transcript.entries.some(
            (entry) => entry.type === "tool" && entry.name.endsWith(name) && entry.phase === "completed",
          ),
        );
      const codexCompleted =
        ["recall_episodes", "get_goal"].every((name) =>
          codexEvents.some((event) => {
            const params = event.params as {
              threadId?: string;
              item?: {
                type?: string;
                server?: string;
                tool?: string;
                status?: string;
                error?: unknown;
                result?: { content?: Array<{ text?: string }> };
              };
            };
            return (
              params.threadId === codex!.threadId &&
              params.item?.type === "mcpToolCall" &&
              params.item.server === "clankie" &&
              params.item.tool === name &&
              params.item.status === "completed" &&
              params.item.error === null &&
              params.item.result?.content?.some(
                (part) =>
                  typeof part.text === "string" &&
                  (name !== "recall_episodes" || part.text.includes("VUH1583_MEMORY_SENTINEL")),
              )
            );
          }),
        ) &&
        codexEvents.some((event) => {
          const params = event.params as { threadId?: string; item?: { type?: string; text?: string } };
          return (
            params.threadId === codex!.threadId &&
            params.item?.type === "agentMessage" &&
            params.item.text?.includes("VUH1583_NATIVE_MCP_OK") &&
            params.item.text.includes("VUH1583_MEMORY_SENTINEL")
          );
        });
      if (completed(claude) && codexCompleted) {
        result.claudeTranscript = claude;
        result.codexTranscript = codexTranscript;
        result.codexNativeEvents = codexEvents;
        result.loopbackObservations = observations;
        assert.equal(
          observations.filter((item) => item.method === "tools/call" && item.name === "recall_episodes")
            .length,
          2,
        );
        assert.equal(
          observations.filter((item) => item.method === "tools/call" && item.name === "get_goal").length,
          2,
        );
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    result.claudeTranscript = claudeTranscript();
    result.codexNativeEvents = codexEvents;
    result.loopbackObservations = observations;
    throw new Error(`Native compatibility not confirmed: ${JSON.stringify(result)}`);
  } finally {
    reader?.close();
    await codex?.close();
    // The caller shuts down its own throwaway Herdr server and all panes it created.
  }
}
