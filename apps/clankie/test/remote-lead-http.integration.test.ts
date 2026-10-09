import { describe, expect, test } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRemoteLeadBridge } from "../src/remote-lead-bridge.ts";
import { RemoteLeadDelegations } from "../src/remote-lead-delegations.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";
import { assertConversationAuthority } from "../src/captain/conversation-owner.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { serve } from "@hono/node-server";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareClaude, leadPlugin } from "../../../integrations/remote-lead/claude-setup.mjs";

const execute = promisify(execFile);

// Host-proof fixtures delimit this HTTP/MCP contract test. Native observation
// and real hire adoption require the separate, deployed Windows live proof.
const nativeSession = "6487aff1-13e8-4bb7-8301-1588cb5d9db2";
const binding = {
  fleet: "pc",
  machine: "pc",
  pane: "w1:p1",
  conversationId: "conv-project",
  nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:claude", kind: "id", value: nativeSession }),
  workingDirectory: "C:\\scratch",
  connectionKey: "connection",
  shell: { pid: 123, startTime: "2026-10-09T00:00:00.0000000Z" },
};
const identity = {
  fleet: "pc",
  pane: "w1:p1",
  current: () => true,
  validate: async () => true,
  projectProof: async () => ({
    ...binding,
    binding: { socketPath: "pipe", session: "default" },
    workspace: { machineId: "pc", platform: "windows" as const, canonicalPath: binding.workingDirectory },
    processes: [{ pid: 456, startTime: "2026-10-09T00:00:01.0000000Z" }],
  }),
};

describe("remote lead HTTP/MCP trust boundary", () => {
  test("launches with an existing signed-in profile and the installed lead channel; the standalone bridge answers a tool call", async () => {
    // Real filesystem, TCP handoff, Node bundle, stdio MCP and HTTP routes.
    // The native Claude executable/auth response and host identity are fixtures;
    // no model request, PC mutation or claim of deployed-head acceptance.
    const root = await mkdtemp(join(tmpdir(), "remote-lead-native-"));
    const repo = resolve(import.meta.dirname, "../../..");
    const profile = join(root, ".claude-james");
    const plugin = join(root, ".clankie/remote-leads/artifact");
    const policyPath = join(root, "managed-settings.json");
    const executable = join(root, "claude");
    await mkdir(profile, { recursive: true });
    await mkdir(join(root, ".claude"));
    await mkdir(plugin, { recursive: true });
    await writeFile(join(profile, ".credentials.json"), "private fixture credential");
    await writeFile(
      policyPath,
      JSON.stringify({
        channelsEnabled: true,
        permissions: { deny: ["secret"] },
        allowedChannelPlugins: [{ marketplace: "clankie", plugin: "clankie-worker" }],
      }),
    );
    await writeFile(
      executable,
      `#!${process.execPath}
      const fs=require('node:fs'); const args=process.argv.slice(2);
      if(args[0]==='auth') console.log(JSON.stringify({loggedIn:process.env.CLAUDE_CONFIG_DIR.endsWith('.claude-james'),authMethod:'claude.ai'}));
      else if(args[0]==='plugin') {
        const statePath=${JSON.stringify(join(root, "plugin-state.json"))};
        const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):[];
        if(args[1]==='list') console.log(JSON.stringify(state));
        else if(args[1]==='install') { fs.writeFileSync(statePath,JSON.stringify([{id:${JSON.stringify(leadPlugin)},scope:'user',enabled:true}])); console.log('{}'); }
        else if(args[1]==='disable') {
          if(state[0]?.failure) { console.log(JSON.stringify(state[0].failure)); process.exit(1); }
          if(state[0]?.enabled===false) {
            console.log(JSON.stringify({command:'disable',plugin:${JSON.stringify(leadPlugin)},scope:'user',failureCode:'already_in_goal_state',alreadyInGoalState:true})); process.exit(1);
          }
          state[0].enabled=false; fs.writeFileSync(statePath,JSON.stringify(state)); console.log('{}');
        } else console.log('{}');
      }
      else fs.writeFileSync(${JSON.stringify(join(root, "head.json"))}, JSON.stringify({args,profile:process.env.CLAUDE_CONFIG_DIR,hasToken:!!process.env.CLANKIE_REMOTE_LEAD_TOKEN}));
    `,
      { mode: 0o700 },
    );
    const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: "" };
    const grants = new RemoteLeadDelegations(async () => {});
    const issued = await grants.issue(binding);
    const bridge = createRemoteLeadBridge({
      delegations: grants,
      identity: () => identity,
      captain: createStubCaptain({
        lanePrompt: async () => "Project lead context",
        pollSeatEvents: async () => {
          await new Promise((r) => setTimeout(r, 25));
          return [];
        },
        laneToolBank: async () => ({
          lane: "operator",
          tools: [
            {
              name: "worker_reports",
              description: "Read reports",
              inputSchema: { type: "object", properties: {} },
              call: async () => ({ content: [{ type: "text", text: "reports accepted" }] }),
            },
          ],
        }),
        syncSeatTranscript: () => true,
      }),
    });
    const host = serve({ fetch: bridge.app.fetch, hostname: "127.0.0.1", port: 0 });
    const handoff = createServer();
    const client = new Client({ name: "bundle-acceptance", version: "1" });
    try {
      expect(await prepareClaude(executable, plugin, { env, home: root, policyPath })).toBe(profile);
      // A relaunch updates the existing install, whose global activation is
      // already off even while the previous session has its channel enabled.
      expect(await prepareClaude(executable, plugin, { env, home: root, policyPath })).toBe(profile);
      const pluginState = join(root, "plugin-state.json");
      const installedLead = { id: leadPlugin, scope: "user", enabled: true };
      await writeFile(pluginState, JSON.stringify([installedLead]));
      expect(await prepareClaude(executable, plugin, { env, home: root, policyPath })).toBe(profile);
      expect(JSON.parse(await readFile(pluginState, "utf8"))[0].enabled).toBe(false);
      // Goal-state handling must not swallow permission or wrong-scope errors.
      for (const failure of [
        { command: "disable", plugin: leadPlugin, scope: "user", failureCode: "permission_denied" },
        {
          command: "disable",
          plugin: leadPlugin,
          scope: "project",
          failureCode: "already_in_goal_state",
          alreadyInGoalState: true,
        },
      ]) {
        await writeFile(pluginState, JSON.stringify([{ ...installedLead, failure }]));
        await expect(prepareClaude(executable, plugin, { env, home: root, policyPath })).rejects.toThrow(
          "Native Claude plugin disable",
        );
      }
      await writeFile(
        pluginState,
        JSON.stringify([
          {
            ...installedLead,
            failure: {
              command: "disable",
              plugin: leadPlugin,
              scope: "user",
              failureCode: "already_in_goal_state",
              alreadyInGoalState: true,
            },
          },
        ]),
      );
      await expect(prepareClaude(executable, plugin, { env, home: root, policyPath })).rejects.toThrow(
        "not disabled at user scope",
      );
      await writeFile(pluginState, JSON.stringify([{ ...installedLead, enabled: false }]));
      expect(await readFile(join(profile, ".credentials.json"), "utf8")).toBe("private fixture credential");
      const policy = JSON.parse(await readFile(policyPath, "utf8"));
      expect(policy.permissions.deny).toContain("secret");
      expect(policy.allowedChannelPlugins).toEqual(
        expect.arrayContaining([
          { marketplace: "clankie", plugin: "clankie-worker" },
          { marketplace: "clankie-remote-leads", plugin: "clankie-remote-lead" },
        ]),
      );
      await writeFile(policyPath, '{"private": "fixture-secret" BROKEN');
      await expect(prepareClaude(executable, plugin, { env, home: root, policyPath })).rejects.toThrow(
        "Invalid channel policy",
      );
      await writeFile(policyPath, JSON.stringify(policy));
      await expect(
        prepareClaude(executable, plugin, {
          env: { ...env, CLAUDE_CONFIG_DIR: join(root, ".claude") },
          home: root,
          policyPath,
        }),
      ).rejects.toThrow("No existing signed-in");
      handoff.on("connection", (socket) =>
        socket.once("data", (chunk) => {
          expect(JSON.parse(chunk.toString()).ticket).toBe("fixture-ticket");
          socket.end(
            JSON.stringify({
              token: issued.token,
              pane: binding.pane,
              fleet: binding.fleet,
              conversationId: binding.conversationId,
              executable,
              profile,
              cwd: root,
              title: "KH2",
              nativeSession,
            }) + "\n",
          );
        }),
      );
      await new Promise<void>((r) => handoff.listen(0, "127.0.0.1", r));
      const address = handoff.address();
      if (!address || typeof address === "string") throw Error("Missing handoff address");
      await execute(
        process.execPath,
        [
          join(repo, "integrations/remote-lead/bootstrap.mjs"),
          "--head",
          String(address.port),
          "fixture-ticket",
        ],
        { env: { ...env, HERDR_PANE_ID: binding.pane } },
      );
      const head = JSON.parse(await readFile(join(root, "head.json"), "utf8"));
      expect(head.profile).toBe(profile);
      expect(head.hasToken).toBe(true);
      expect(head.args).toContain(`plugin:${leadPlugin}`);
      expect(head.args).not.toContain("--dangerously-load-development-channels");
      expect(head.args).not.toContain("--plugin-dir");
      expect(
        JSON.parse(head.args[head.args.indexOf("--settings") + 1]).enabledPlugins["clankie-worker@clankie"],
      ).toBe(false);
      await execute(process.execPath, [join(repo, "scripts/build-remote-lead.mjs")], { cwd: repo });
      const httpAddress = host.address();
      if (!httpAddress || typeof httpAddress === "string") throw Error("Missing HTTP address");
      await mkdir(join(root, ".clankie/links"), { recursive: true });
      await writeFile(
        join(root, ".clankie/links/pc.json"),
        JSON.stringify({
          schemaVersion: 2,
          authentication: "local-process",
          fleet: "pc",
          url: `http://127.0.0.1:${httpAddress.port}`,
        }),
      );
      const nativeEnv = {
        ...env,
        CLANKIE_REMOTE_LEAD_TOKEN: issued.token,
        HERDR_PANE_ID: binding.pane,
        CLANKIE_REMOTE_LEAD_FLEET: "pc",
        CLANKIE_CONVERSATION_ID: binding.conversationId,
        CLANKIE_SEAT_SESSION_ID: nativeSession,
        CLANKIE_SEAT_HARNESS: "claude",
      };
      const bundle = join(repo, ".local/remote-lead/remote-lead-mcp.mjs");
      expect((await execute(process.execPath, [bundle, "--prompt"], { env: nativeEnv })).stdout).toBe(
        "Project lead context",
      );
      const sync = spawn(process.execPath, [bundle, "--sync"], {
        env: nativeEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const synced = new Promise<number | null>((r, reject) => {
        sync.once("error", reject);
        sync.once("exit", r);
      });
      sync.stdin.end(
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: nativeSession,
          transcript_path: join(root, `${nativeSession}.jsonl`),
        }),
      );
      expect(await synced).toBe(0);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [bundle],
          env: Object.fromEntries(
            Object.entries(nativeEnv).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          stderr: "pipe",
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("worker_reports");
      expect((await client.callTool({ name: "worker_reports", arguments: {} })).content).toEqual([
        { type: "text", text: "reports accepted" },
      ]);
    } finally {
      await client.close();
      await bridge.close();
      if ("closeAllConnections" in host) host.closeAllConnections();
      await new Promise<void>((r) => host.close(() => r()));
      await new Promise<void>((r) => handoff.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  });
  test("binds chat/session, excludes owner routes and refuses revoked calls on an existing MCP session", async () => {
    const grants = new RemoteLeadDelegations(async () => {});
    const issued = await grants.issue(binding);
    let effects = 0;
    let held = false;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = createRemoteLeadBridge({
      delegations: grants,
      identity: () => identity,
      captain: createStubCaptain({
        syncSeatTranscript: (conversationId, transcript) => {
          expect(conversationId).toBe(binding.conversationId);
          expect(transcript.sessionId).toBe(nativeSession);
          return true;
        },
        laneToolBank: async (_lane, conversationId, authority) => {
          expect(conversationId).toBe(binding.conversationId);
          expect(authority?.owner.conversationId).toBe(binding.conversationId);
          return {
            lane: _lane,
            tools: ["hire_agent", "owner_settings"].map((name) => ({
              name,
              description: name,
              inputSchema: { type: "object", properties: {} },
              call: async () => {
                if (held) {
                  enter();
                  await resume;
                }
                await assertConversationAuthority(authority!);
                effects++;
                return { content: [{ type: "text" as const, text: "accepted" }] };
              },
            })),
          };
        },
      }),
    });
    const headers = { authorization: `Bearer ${issued.token}` };
    const request = (path: string, init?: RequestInit) => bridge.app.request(path, { headers, ...init });
    const client = new Client({ name: "trust-boundary", version: "1" });
    try {
      expect((await request("/v1/fleet/lead/mcp?conversationId=conv-other")).status).toBe(403);
      expect(
        (
          await request("/v1/fleet/lead/transcript", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ sessionId: "22c7c3a3-f024-4764-afc6-cc58e3a4f54e", entries: [] }),
          })
        ).status,
      ).toBe(403);
      expect(
        (await request("/v1/fleet/lead/mcp", { headers: { authorization: "Bearer worker-token" } })).status,
      ).toBe(403);
      expect(
        (
          await request("/v1/fleet/lead/transcript", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ sessionId: nativeSession, entries: [] }),
          })
        ).status,
      ).toBe(200);
      const owner = createBearerAuthenticator("separate-owner-secret", { operatorId: "owner" });
      expect(await owner(new Request("http://service/v1/remote-leads/revoke", { headers }))).toBeUndefined();
      expect(
        (
          await fleetLinkFetch((request) => bridge.app.fetch(request))(
            new Request("http://service/v1/remote-leads/revoke", { method: "POST", headers }),
          )
        ).status,
      ).toBe(404);
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://service/v1/fleet/lead/mcp"), {
          requestInit: { headers },
          fetch: async (input, init) => bridge.app.fetch(new Request(input, init)),
        }) as unknown as Transport,
      );
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toContain("hire_agent");
      expect(catalog.tools.map((tool) => tool.name)).not.toContain("owner_settings");
      expect((await client.callTool({ name: "hire_agent", arguments: {} })).isError).not.toBe(true);
      expect(effects).toBe(1);
      held = true;
      const queued = client.callTool({ name: "hire_agent", arguments: {} }).catch(() => undefined);
      await entered;
      grants.revoke(issued.id);
      release();
      await queued;
      await expect(client.callTool({ name: "hire_agent", arguments: {} })).rejects.toThrow();
      expect(effects).toBe(1);
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
