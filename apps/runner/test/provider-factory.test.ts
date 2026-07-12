import { chmod, mkdtemp, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBundledPiRpcEntry } from "@clankie/worker-pi";
import type { WorkerRunContext } from "@clankie/worker-sdk";
import { describe, expect, it } from "vitest";
import {
  createPiProcessPreparer,
  createReadyProviderFleet,
  probePiBoundary,
} from "../src/provider-factory.ts";

describe("provider readiness factory", () => {
  const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.c2ln";

  it("fails closed with every provider disabled by default", async () => {
    const fleet = await createReadyProviderFleet({
      environment: {},
      workerEnvironment: { PATH: process.env.PATH, HOME: "/synthetic/home" },
      runnerStateRoot: await mkdtemp(join(tmpdir(), "clankie-provider-state-")),
    });
    expect(fleet.adapters).toEqual([]);
    expect(fleet.reports.map((report) => report.status)).toEqual(["disabled", "disabled", "disabled"]);
  });

  it("advertises only fully ready heterogeneous provider roles", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "clankie-provider-ready-"));
    const codexHome = await mkdtemp(join(tmpdir(), "clankie-provider-authenticated-codex-"));
    await writeFile(
      join(codexHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" })}\n`,
      { mode: 0o600 },
    );
    const fleet = await createReadyProviderFleet({
      environment: {
        CLANKIE_CODEX_ENABLED: "true",
        CLANKIE_CODEX_MODEL: "gpt-codex",
        CLANKIE_CODEX_EXECUTABLE: "/provider/codex",
        CLANKIE_CLAUDE_ENABLED: "true",
        CLANKIE_CLAUDE_MODEL: "claude-verifier",
        CLANKIE_CLAUDE_EXECUTABLE: "/provider/claude",
        ANTHROPIC_API_KEY: "SECRET_CLAUDE_AUTH",
        CLANKIE_PI_ENABLED: "true",
        CLANKIE_PI_MODEL: "local-coder:latest",
        CLANKIE_PI_OLLAMA_URL: "http://127.0.0.1:11434",
      },
      workerEnvironment: {
        PATH: process.env.PATH,
        HOME: "/synthetic/home",
        CODEX_HOME: codexHome,
      },
      runnerStateRoot: stateRoot,
      sandbox: {
        prepare: (identity, invocation, environment) =>
          Promise.resolve({
            ...invocation,
            environment,
            profile: "elevated",
            collectDenials: () => Promise.resolve([]),
            close: () => Promise.resolve(),
          }),
      },
      probes: {
        executable: (command) => Promise.resolve(command.includes("pi") ? "pi-0.80.6" : "1.0.0"),
        isolation: () => Promise.resolve(true),
        codexAuth: () => Promise.resolve(true),
        codexBoundary: () => Promise.resolve(true),
        claudeAuth: () => Promise.resolve(true),
        ollamaModels: () => Promise.resolve(["local-coder:latest"]),
        piBoundary: () => Promise.resolve(true),
      },
    });
    expect(fleet.reports.map((report) => report.status)).toEqual(["ready", "ready", "ready"]);
    expect(fleet.adapters.map((adapter) => adapter.descriptor.id).sort()).toEqual([
      "claude-verification",
      "codex-implementation",
      "pi-debugging",
    ]);
    expect(fleet.adapters.map((adapter) => adapter.descriptor.capabilities.kinds)).toEqual(
      expect.arrayContaining([["implementation", "integration"], ["verification", "review"], ["debugging"]]),
    );
    expect(
      fleet.adapters.find((adapter) => adapter.descriptor.id === "claude-verification")?.descriptor,
    ).toMatchObject({ harness: "claude", capabilities: { canWrite: false } });
    expect([...fleet.metadata.values()].map((entry) => entry.provider).sort()).toEqual([
      "claude",
      "codex",
      "pi",
    ]);
    expect(JSON.stringify(fleet.reports)).not.toContain("SECRET_CLAUDE_AUTH");
    for (const directory of ["home", "home/tmp", "home/.config", "home/.cache", "config", "sessions"]) {
      expect((await stat(join(stateRoot, "providers", "pi", directory))).mode & 0o777).toBe(0o700);
    }
  });

  it("projects Pi into exact positive read, write, and Ollama network roots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clankie-pi-positive-workspace-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "clankie-pi-positive-state-"));
    const runtimeRoot = await mkdtemp(join(tmpdir(), "clankie-pi-positive-runtime-"));
    let request: unknown;
    const preparer = createPiProcessPreparer({
      sandbox: {
        prepare: (_identity, invocation, environment, requested) => {
          request = requested;
          return Promise.resolve({
            ...invocation,
            environment,
            profile: "elevated",
            collectDenials: () => Promise.resolve([]),
            close: () => Promise.resolve(),
          });
        },
      },
      stateRoot,
      readableRoots: [stateRoot, runtimeRoot],
      ollamaUrl: new URL("http://127.0.0.1:11434"),
    });
    await preparer({
      command: "/provider/pi",
      args: ["--help"],
      environment: { PATH: "/usr/bin" },
      cwd: workspace,
      run: providerRunContext(workspace),
    });
    expect(request).toEqual({
      networkTargets: [{ host: "127.0.0.1", port: 11434 }],
      additionalWritableRoots: [stateRoot],
      readableRoots: [stateRoot, runtimeRoot],
      runtimeReadEntries: [resolveBundledPiRpcEntry()],
    });
  });

  it("requires sandboxed Ollama tags and a matching initialized Pi RPC model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clankie-pi-boundary-workspace-"));
    const sessions = await mkdtemp(join(tmpdir(), "clankie-pi-boundary-sessions-"));
    const command = await fakePiRpcCommand("local-coder:latest");
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "local-coder:latest" }] }));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Pi readiness server did not bind");
    const processPreparer = passthroughPiPreparer();
    try {
      await expect(
        probePiBoundary({
          command,
          environment: { PATH: process.env.PATH },
          workspacePath: workspace,
          processPreparer,
          model: "local-coder:latest",
          ollamaUrl: new URL(`http://127.0.0.1:${String(address.port)}`),
          sessionRoot: sessions,
        }),
      ).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("fails Pi readiness when initialized RPC state does not bind the configured model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clankie-pi-boundary-failure-"));
    const command = await fakePiRpcCommand("wrong-model");
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "local-coder:latest" }] }));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Pi readiness server did not bind");
    try {
      await expect(
        probePiBoundary({
          command,
          environment: { PATH: process.env.PATH },
          workspacePath: workspace,
          processPreparer: passthroughPiPreparer(),
          model: "local-coder:latest",
          ollamaUrl: new URL(`http://127.0.0.1:${String(address.port)}`),
          sessionRoot: workspace,
        }),
      ).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it.each([
    { label: "missing session id", rpc: { sessionId: null } },
    { label: "missing session file", rpc: { sessionFile: "" } },
    { label: "session file equal to session root", rpc: { sessionFileAtRoot: true } },
    { label: "escaped session file", rpc: { sessionFile: "/tmp/pi-readiness-escape.jsonl" } },
  ])("fails Pi readiness for $label", async ({ rpc }) => {
    const workspace = await mkdtemp(join(tmpdir(), "clankie-pi-session-failure-"));
    const sessions = await mkdtemp(join(tmpdir(), "clankie-pi-session-root-"));
    const command = await fakePiRpcCommand("local-coder:latest", rpc);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "local-coder:latest" }] }));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Pi readiness server did not bind");
    try {
      await expect(
        probePiBoundary({
          command,
          environment: { PATH: process.env.PATH },
          workspacePath: workspace,
          processPreparer: passthroughPiPreparer(),
          model: "local-coder:latest",
          ollamaUrl: new URL(`http://127.0.0.1:${String(address.port)}`),
          sessionRoot: sessions,
        }),
      ).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("fails Pi readiness when a session path escapes through a symlink", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clankie-pi-symlink-workspace-"));
    const sessions = await mkdtemp(join(tmpdir(), "clankie-pi-symlink-session-root-"));
    const outside = await mkdtemp(join(tmpdir(), "clankie-pi-symlink-outside-"));
    const escapedDirectory = join(sessions, "escaped");
    await symlink(outside, escapedDirectory, "dir");
    const command = await fakePiRpcCommand("local-coder:latest", {
      sessionFile: join(escapedDirectory, "readiness-session.jsonl"),
    });
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "local-coder:latest" }] }));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Pi readiness server did not bind");
    try {
      await expect(
        probePiBoundary({
          command,
          environment: { PATH: process.env.PATH },
          workspacePath: workspace,
          processPreparer: passthroughPiPreparer(),
          model: "local-coder:latest",
          ollamaUrl: new URL(`http://127.0.0.1:${String(address.port)}`),
          sessionRoot: sessions,
        }),
      ).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("rejects an empty Codex auth document even when login status could succeed from Keychain", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "clankie-codex-empty-auth-"));
    await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
    let loginProbeCalls = 0;
    const fleet = await createReadyProviderFleet({
      environment: {
        CLANKIE_CODEX_ENABLED: "true",
        CLANKIE_CODEX_MODEL: "gpt-codex",
        CLANKIE_CODEX_EXECUTABLE: "/usr/bin/false",
      },
      workerEnvironment: { PATH: process.env.PATH, HOME: "/synthetic/home", CODEX_HOME: codexHome },
      runnerStateRoot: await mkdtemp(join(tmpdir(), "clankie-codex-unready-")),
      probes: {
        executable: () => Promise.resolve("codex-test"),
        isolation: () => Promise.resolve(true),
        codexAuth: () => {
          loginProbeCalls += 1;
          return Promise.resolve(true);
        },
        codexBoundary: () => Promise.resolve(false),
      },
    });
    const report = fleet.reports.find((entry) => entry.provider === "codex");
    expect(report).toMatchObject({ status: "unavailable" });
    expect(report?.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["auth_file_invalid", "tool_boundary_unavailable"]),
    );
    expect(loginProbeCalls).toBe(0);
  });

  it("accepts every supported file-backed Codex auth mode before the bounded login probe", async () => {
    const documents = [
      { auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" },
      { OPENAI_API_KEY: "inferred-api-key" },
      {
        auth_mode: "chatgpt",
        tokens: { id_token: jwt, access_token: "access", refresh_token: "refresh", account_id: "account" },
      },
      {
        tokens: { id_token: jwt, access_token: "access", refresh_token: "refresh", account_id: null },
      },
      {
        auth_mode: "chatgpt",
        agent_identity: {
          agent_runtime_id: "agent-runtime-id",
          agent_private_key: "private-key",
          account_id: "account-id",
          chatgpt_user_id: "user-id",
          email: "user@example.com",
          plan_type: "pro",
          chatgpt_account_is_fedramp: false,
          task_id: "task-id",
        },
      },
      {
        auth_mode: "chatgptAuthTokens",
        tokens: { id_token: jwt, access_token: "access", refresh_token: "", account_id: "account" },
      },
      { auth_mode: "agentIdentity", agent_identity: jwt },
      {
        auth_mode: "agentIdentity",
        agent_identity: {
          agent_runtime_id: "runtime",
          agent_private_key: "private-key",
          account_id: "account",
          chatgpt_user_id: "user",
          plan_type: "pro",
          chatgpt_account_is_fedramp: false,
        },
      },
      { auth_mode: "personalAccessToken", personal_access_token: "pat" },
      { personal_access_token: "inferred-pat" },
      { auth_mode: "bedrockApiKey", bedrock_api_key: { api_key: "bedrock", region: "us-east-1" } },
      { bedrock_api_key: { api_key: "inferred-bedrock", region: "us-east-1" } },
    ];
    for (const document of documents) {
      const fleet = await codexFleet(document);
      expect(fleet.reports.find((entry) => entry.provider === "codex")).toMatchObject({
        status: "ready",
        issues: [],
      });
    }
  });

  it("rejects malformed, incomplete, and externally supplied Codex auth documents", async () => {
    const malformed = [
      null,
      [],
      { auth_mode: "unknown", OPENAI_API_KEY: "key" },
      { auth_mode: "apikey", OPENAI_API_KEY: " " },
      { auth_mode: "chatgpt", tokens: { id_token: jwt, access_token: "access", refresh_token: "" } },
      {
        auth_mode: "chatgpt",
        tokens: { id_token: "not-a-jwt", access_token: "access", refresh_token: "refresh" },
      },
      { auth_mode: "agentIdentity", agent_identity: { agent_runtime_id: "only-one-field" } },
      { auth_mode: "personalAccessToken", personal_access_token: "" },
      { auth_mode: "bedrockApiKey", bedrock_api_key: { api_key: "key", region: "" } },
      { auth_mode: "headers" },
      { auth_mode: "apikey", OPENAI_API_KEY: "key", last_refresh: "not-a-date" },
    ];
    for (const document of malformed) {
      let loginProbeCalls = 0;
      const fleet = await codexFleet(document, () => {
        loginProbeCalls += 1;
        return Promise.resolve(true);
      });
      expect(fleet.reports.find((entry) => entry.provider === "codex")?.issues).toContainEqual(
        expect.objectContaining({ code: "auth_file_invalid" }),
      );
      expect(loginProbeCalls).toBe(0);
    }
  });

  it("rejects unsafe Codex auth files before probing login status", async () => {
    const worldReadableHome = await mkdtemp(join(tmpdir(), "clankie-codex-world-readable-"));
    const worldReadableAuth = join(worldReadableHome, "auth.json");
    await writeFile(worldReadableAuth, '{"auth_mode":"apikey","OPENAI_API_KEY":"test"}\n', {
      mode: 0o600,
    });
    await chmod(worldReadableAuth, 0o644);

    const symlinkHome = await mkdtemp(join(tmpdir(), "clankie-codex-symlink-"));
    const target = join(symlinkHome, "target.json");
    await writeFile(target, '{"auth_mode":"apikey","OPENAI_API_KEY":"test"}\n', { mode: 0o600 });
    await symlink(target, join(symlinkHome, "auth.json"));

    for (const codexHome of [worldReadableHome, symlinkHome]) {
      const fleet = await codexFleet(undefined, () => Promise.resolve(true), codexHome);
      expect(fleet.reports.find((entry) => entry.provider === "codex")?.issues).toContainEqual(
        expect.objectContaining({ code: "auth_file_unavailable" }),
      );
    }
  });

  it("rejects a Codex auth file replaced by a symlink during login status", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "clankie-codex-auth-swap-"));
    const authFile = join(codexHome, "auth.json");
    const movedAuth = join(codexHome, "moved-auth.json");
    await writeFile(authFile, '{"auth_mode":"apikey","OPENAI_API_KEY":"test"}\n', { mode: 0o600 });
    const fleet = await codexFleet(
      undefined,
      async () => {
        await rename(authFile, movedAuth);
        await symlink(movedAuth, authFile);
        return true;
      },
      codexHome,
    );
    expect(fleet.reports.find((entry) => entry.provider === "codex")?.issues).toContainEqual(
      expect.objectContaining({ code: "auth_file_unavailable" }),
    );
  });

  it("rejects an atomic replacement with a different valid Codex auth file", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "clankie-codex-auth-replacement-"));
    const authFile = join(codexHome, "auth.json");
    const replacement = join(codexHome, "replacement.json");
    await writeFile(authFile, '{"auth_mode":"apikey","OPENAI_API_KEY":"first"}\n', { mode: 0o600 });
    await writeFile(replacement, '{"auth_mode":"apikey","OPENAI_API_KEY":"second"}\n', {
      mode: 0o600,
    });
    const fleet = await codexFleet(
      undefined,
      async () => {
        await rename(replacement, authFile);
        return true;
      },
      codexHome,
    );
    expect(fleet.reports.find((entry) => entry.provider === "codex")?.issues).toContainEqual(
      expect.objectContaining({ code: "auth_file_unavailable" }),
    );
  });

  it("rejects partial cloud credentials and consumer Claude OAuth/config state", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "clankie-claude-consumer-auth-"));
    await writeFile(join(configDirectory, "auth.json"), '{"consumer":"oauth"}\n', { mode: 0o600 });
    const base = {
      CLANKIE_CLAUDE_ENABLED: "true",
      CLANKIE_CLAUDE_MODEL: "claude-verifier",
      CLANKIE_CLAUDE_EXECUTABLE: "/provider/claude",
      CLAUDE_CONFIG_DIR: configDirectory,
    };
    for (const environment of [
      { ...base, AWS_ACCESS_KEY_ID: "partial-only" },
      { ...base, CLAUDE_CODE_OAUTH_TOKEN: "consumer-max-token" },
    ]) {
      const fleet = await createReadyProviderFleet({
        environment,
        workerEnvironment: { PATH: process.env.PATH, HOME: "/synthetic/home" },
        runnerStateRoot: await mkdtemp(join(tmpdir(), "clankie-claude-unready-")),
        probes: {
          executable: () => Promise.resolve("claude-test"),
          isolation: () => Promise.resolve(true),
        },
      });
      expect(fleet.adapters).toEqual([]);
      expect(fleet.reports.find((entry) => entry.provider === "claude")?.issues).toContainEqual(
        expect.objectContaining({ code: "auth_unavailable" }),
      );
    }
  });

  it("does not advertise an enabled provider when readiness fails and reports no credential content", async () => {
    const secret = "SECRET_SENTINEL_provider_auth";
    const fleet = await createReadyProviderFleet({
      environment: {
        CLANKIE_CLAUDE_ENABLED: "true",
        CLANKIE_CLAUDE_MODEL: "claude-verifier",
        CLANKIE_CLAUDE_EXECUTABLE: "/missing/claude",
        ANTHROPIC_API_KEY: secret,
      },
      workerEnvironment: { HOME: "/synthetic/home" },
      runnerStateRoot: await mkdtemp(join(tmpdir(), "clankie-provider-failed-")),
      probes: {
        executable: () => Promise.reject(new Error(`could not use ${secret}`)),
        isolation: () => Promise.resolve(false),
        claudeAuth: () => Promise.resolve(false),
      },
    });
    expect(fleet.adapters).toEqual([]);
    const report = fleet.reports.find((entry) => entry.provider === "claude");
    expect(report?.status).toBe("unavailable");
    expect(report?.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["executable_unavailable", "auth_unavailable", "isolation_unavailable"]),
    );
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("rejects non-loopback Pi inference origins before advertisement", async () => {
    const fleet = await createReadyProviderFleet({
      environment: {
        CLANKIE_PI_ENABLED: "true",
        CLANKIE_PI_MODEL: "local-coder:latest",
        CLANKIE_PI_OLLAMA_URL: "https://models.example.invalid/v1?token=SECRET",
      },
      workerEnvironment: { HOME: "/synthetic/home" },
      runnerStateRoot: await mkdtemp(join(tmpdir(), "clankie-provider-loopback-")),
      sandbox: {
        prepare: () => Promise.reject(new Error("not invoked")),
      },
      probes: {
        executable: () => Promise.resolve("0.80.6"),
        isolation: () => Promise.resolve(true),
      },
    });
    expect(fleet.adapters).toEqual([]);
    const report = fleet.reports.find((entry) => entry.provider === "pi");
    expect(report).toMatchObject({ status: "unavailable" });
    expect(report?.issues).toContainEqual(expect.objectContaining({ code: "ollama_url_invalid" }));
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });
});

async function codexFleet(
  authDocument: unknown,
  codexAuth: () => Promise<boolean> = () => Promise.resolve(true),
  existingCodexHome?: string,
) {
  const codexHome = existingCodexHome ?? (await mkdtemp(join(tmpdir(), "clankie-codex-auth-schema-")));
  if (!existingCodexHome) {
    await writeFile(join(codexHome, "auth.json"), `${JSON.stringify(authDocument)}\n`, { mode: 0o600 });
  }
  return createReadyProviderFleet({
    environment: {
      CLANKIE_CODEX_ENABLED: "true",
      CLANKIE_CODEX_MODEL: "gpt-codex",
      CLANKIE_CODEX_EXECUTABLE: "/provider/codex",
    },
    workerEnvironment: { PATH: process.env.PATH, HOME: "/synthetic/home", CODEX_HOME: codexHome },
    runnerStateRoot: await mkdtemp(join(tmpdir(), "clankie-codex-schema-state-")),
    probes: {
      executable: () => Promise.resolve("codex-test"),
      isolation: () => Promise.resolve(true),
      codexAuth,
      codexBoundary: () => Promise.resolve(true),
    },
  });
}

function providerRunContext(workspacePath: string): WorkerRunContext {
  return {
    missionId: "provider-test",
    workerRunId: "provider-run",
    task: {
      id: "provider-task",
      title: "Provider task",
      objective: "Exercise a provider process boundary.",
      kind: "debugging",
      role: "debugger",
      dependsOn: [],
      executionClass: "automatic",
      risk: "low",
      writeScope: [],
      successCriteria: ["boundary is explicit"],
      evidenceRequirements: ["captured request"],
      maxAttempts: 1,
      metadata: {},
    },
    workspacePath,
    profileHash: "provider-profile",
    attempt: 1,
    signal: new AbortController().signal,
    emit: () => undefined,
  };
}

function passthroughPiPreparer(): ReturnType<typeof createPiProcessPreparer> {
  return async (input) => ({
    command: input.command,
    args: input.args,
    environment: input.environment,
  });
}

async function fakePiRpcCommand(
  model: string,
  options: { sessionId?: string | null; sessionFile?: string; sessionFileAtRoot?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-fake-pi-rpc-"));
  const command = join(root, "pi-rpc.mjs");
  await writeFile(
    command,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { join } from "node:path";
const model = ${JSON.stringify(model)};
const sessionDirectory = process.argv[process.argv.indexOf("--session-dir") + 1];
const sessionId = ${JSON.stringify(options.sessionId === undefined ? "readiness-session" : options.sessionId)};
const sessionFile = ${options.sessionFileAtRoot ? "sessionDirectory" : options.sessionFile === undefined ? 'join(sessionDirectory, "readiness-session.jsonl")' : JSON.stringify(options.sessionFile)};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const data = request.type === "get_state"
    ? { model: { provider: "ollama", id: model }, sessionId, sessionFile }
    : request.type === "get_available_models"
      ? { models: [{ provider: "ollama", id: model }] }
      : {};
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
}
`,
    { mode: 0o700 },
  );
  await chmod(command, 0o700);
  return command;
}
import { createServer } from "node:http";
