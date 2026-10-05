import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Type } from "typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore, emptySettings, workSafetySettings } from "@clankie/settings";
import { SafetyApprovalsSchema, SafetyStatusSchema } from "@clankie/protocol";
import { expect, it } from "vitest";
import { runSafetyCommand } from "../../tui/src/command/safety.ts";
import { SafetyBoundary, safetyExtension } from "../src/safety.ts";
import { createSafetyRoutes } from "../src/safety-routes.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { assembleLanePrompt } from "../src/captain/captain.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-safety-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const store = new FileCredentialStore(join(root, "credentials.json"));
  const env = { CLANKIE_OPERATOR_TOKEN: randomUUID() };
  const boundary = new SafetyBoundary(async () => (await settings.load()).safety);
  const authenticate = createCredentialBackedOperatorAuthenticator({
    env,
    store,
    identity: { operatorId: "owner" },
  });
  const app = createSafetyRoutes({
    settings,
    boundary,
    authorize: async (request) => {
      const identity = await authenticate(request);
      return Boolean(identity);
    },
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback address");
  const host = `http://127.0.0.1:${address.port}`;
  const options = { host, env, operatorCredentialStore: store };
  return {
    root,
    settings,
    boundary,
    host,
    options,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function piSession(root: string, boundary?: SafetyBoundary) {
  const settingsManager = SettingsManager.inMemory();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: boundary ? [safetyExtension(boundary, () => "operator:work:owner")] : [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    tools: ["read", "write", "bash", "driver"],
    customTools: [
      {
        name: "driver",
        label: "Exercise native tool execution",
        description: "Run a tool through the native executor",
        parameters: Type.Object({ tool: Type.String(), arguments: Type.Any() }),
        async execute(_id, input, _signal, _update, context) {
          const params = input as { tool: string; arguments: Record<string, unknown> };
          const result = await context.executeTool(params.tool, params.arguments);
          return { content: result.result.content, details: { isError: result.isError } };
        },
      },
    ],
  });
  await session.bindExtensions({ mode: "print" });
  const driver = session.agent.state.tools.find((tool) => tool.name === "driver")!;
  return {
    session,
    call: (tool: string, args: Record<string, string>) => {
      const id = randomUUID();
      const input = { tool, arguments: args };
      session.agent.state.messages = [
        ...session.agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "toolCall", id, name: "driver", arguments: input }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "toolUse",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ];
      return driver.execute(id, input);
    },
  };
}

it("enforces live owner settings through real HTTP, CLI, Pi execution and filesystem effects", async () => {
  const host = await fixture();
  const pi = await piSession(host.root, host.boundary);
  const native = await piSession(host.root);
  const path = join(host.root, "code.ts");
  try {
    const defaults = SafetyStatusSchema.parse(await runSafetyCommand([], host.options));
    expect(defaults.safety.codeExecution).toBe("direct");
    await runSafetyCommand(["preset", "work"], host.options);
    expect((await new SettingsStore(host.settings.path).load()).safety).toEqual(workSafetySettings());
    for (const token of [undefined, "captain", "worker"]) {
      const refused = await fetch(`${host.host}/v1/operator/safety`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ codeExecution: "direct" }),
      });
      expect(refused.status).toBe(401);
    }
    const blocked = await pi.call("write", { path, content: "unapproved" });
    expect(blocked.details).toEqual({ isError: true });
    expect(JSON.stringify(blocked)).toContain("safety_denied");
    await expect(readFile(path, "utf8")).rejects.toThrow();
    const shell = await pi.call("bash", { command: `touch '${path}'` });
    expect(JSON.stringify(shell)).toContain("safety_denied");
    await expect(readFile(path, "utf8")).rejects.toThrow();
    await native.call("write", { path, content: "worker keeps native permissions" });
    expect(await readFile(path, "utf8")).toBe("worker keeps native permissions");
    expect(assembleLanePrompt("operator", true, await host.settings.load())).toContain("Never push to main");
    await runSafetyCommand(
      [
        "set",
        JSON.stringify({
          codeExecution: "direct",
          defaultDecision: "ask",
          rules: [{ tool: "write", decision: "ask" }],
        }),
      ],
      host.options,
    );
    const draft = { path, content: "reviewed content" };
    const pending = await pi.call("write", draft);
    expect(JSON.stringify(pending)).toContain("safety_approval_required");
    expect(await readFile(path, "utf8")).toBe("worker keeps native permissions");
    const { approvals } = SafetyApprovalsSchema.parse(await runSafetyCommand(["approvals"], host.options));
    const request = approvals.find((approval) => approval.status === "pending")!;
    expect(request.arguments).toEqual(draft);
    const forged = await fetch(`${host.host}/v1/operator/safety/approvals`, {
      method: "POST",
      headers: { authorization: "Bearer worker", "content-type": "application/json" },
      body: JSON.stringify({ id: request.id, fingerprint: request.fingerprint, approve: true }),
    });
    expect(forged.status).toBe(401);
    await runSafetyCommand(["approve", request.id, request.fingerprint], host.options);
    const changed = await pi.call("write", { ...draft, content: "different content" });
    expect(JSON.stringify(changed)).toContain("safety_approval_required");
    const approved = await pi.call("write", draft);
    expect(approved.details).toEqual({ isError: false });
    expect(await readFile(path, "utf8")).toBe("reviewed content");
    expect(JSON.stringify(await pi.call("write", draft))).toContain("safety_approval_required");
    await runSafetyCommand(["preset", "default"], host.options);
    await pi.call("write", { path, content: "default behavior restored" });
    expect(await readFile(path, "utf8")).toBe("default behavior restored");
  } finally {
    pi.session.dispose();
    native.session.dispose();
    await host.close();
  }
});

it("keeps approvals bound to scope, settings and lifetime, and loses them on restart", async () => {
  const host = await fixture();
  try {
    await runSafetyCommand(["preset", "work"], host.options);
    const tool = "linear_create_comment";
    const args = { issueId: "issue-17", body: "draft first" };
    await expect(host.boundary.check("owner-thread", tool, args)).rejects.toThrow("safety_approval_required");
    const request = host.boundary.list()[0]!;
    await runSafetyCommand(["approve", request.id, request.fingerprint], host.options);
    await expect(host.boundary.check("another-thread", tool, args)).rejects.toThrow(
      "safety_approval_required",
    );
    await runSafetyCommand(["set", JSON.stringify({ instructions: "new owner instructions" })], host.options);
    await expect(host.boundary.check("owner-thread", tool, args)).rejects.toThrow("safety_approval_required");
    const current = host.boundary
      .list()
      .find((approval) => approval.status === "pending" && approval.scope === "owner-thread")!;
    await expect(runSafetyCommand(["approve", current.id, "0".repeat(64)], host.options)).rejects.toThrow(
      "safety_request_changed",
    );
    await runSafetyCommand(["reject", current.id, current.fingerprint], host.options);
    await expect(host.boundary.check("owner-thread", tool, args)).rejects.toThrow("safety_rejected");
    const restarted = new SafetyBoundary(async () => (await host.settings.load()).safety);
    await expect(restarted.check("owner-thread", tool, args)).rejects.toThrow("safety_approval_required");
    let now = Date.now();
    const expiring = new SafetyBoundary(
      async () => (await host.settings.load()).safety,
      () => now,
    );
    await expect(expiring.check("owner-thread", tool, args)).rejects.toThrow();
    const expires = expiring.list()[0]!;
    await expiring.answer(expires.id, expires.fingerprint, true);
    now += 15 * 60_000;
    await expect(expiring.check("owner-thread", tool, args)).rejects.toThrow("safety_approval_required");
    expect(expiring.list()[0]!.id).not.toBe(expires.id);
    await runSafetyCommand(
      [
        "set",
        JSON.stringify({
          rules: [
            { tool: "linear_*", decision: "deny" },
            { tool, decision: "allow" },
          ],
        }),
      ],
      host.options,
    );
    await expect(host.boundary.check("owner-thread", tool, args)).rejects.toThrow("safety_denied");
    expect(emptySettings().safety.defaultDecision).toBe("allow");
  } finally {
    await host.close();
  }
});
