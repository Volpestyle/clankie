import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { SqliteEventStore } from "@clankie/event-store";
import type { DomainEvent } from "@clankie/protocol";
import { resolveBundledPiRpcEntry } from "@clankie/worker-pi";
import { afterEach, describe, expect, it } from "vitest";
import { createPiProcessPreparer, probePiBoundary } from "../src/provider-factory.ts";
import { parseTlsServerName, ShellSandbox } from "../src/sandbox.ts";
import { ShellWorkerAdapter } from "../src/shell-worker.ts";

const servers: Server[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeAllConnections();
        }),
    ),
  );
});

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clankie-sandbox-work-"));
}

function runContext(path: string, events: Array<Omit<DomainEvent, "id" | "occurredAt" | "correlationId">>) {
  return {
    missionId: "mission-sandbox",
    workerRunId: "run-sandbox",
    task: {
      id: "task-sandbox",
      title: "Exercise sandbox",
      objective: "Prove the worker boundary.",
      kind: "implementation" as const,
      role: "implementer" as const,
      dependsOn: [],
      executionClass: "automatic" as const,
      risk: "low" as const,
      writeScope: [path],
      successCriteria: ["Sandbox behavior is explicit."],
      evidenceRequirements: ["Structured denial evidence."],
      maxAttempts: 1,
      metadata: {},
    },
    workspacePath: path,
    profileHash: "profile-sandbox",
    attempt: 1,
    signal: new AbortController().signal,
    emit: (event: Omit<DomainEvent, "id" | "occurredAt" | "correlationId">) => events.push(event),
  };
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return { server, port: address.port };
}

function tlsClientHello(host: string): Buffer {
  const name = Buffer.from(host, "ascii");
  const serverName = Buffer.concat([Buffer.from([0, name.length + 3, 0, 0, name.length]), name]);
  const extension = Buffer.concat([Buffer.from([0, 0, 0, serverName.length]), serverName]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0, 0, 2, 0x13, 0x01, 1, 0, 0, extension.length]),
    extension,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, 0, 0, body.length]), body]);
  return Buffer.concat([Buffer.from([22, 3, 1, 0, handshake.length]), handshake]);
}

describe("TLS CONNECT inspection", () => {
  it("extracts and normalizes the ClientHello server name", () => {
    expect(parseTlsServerName(tlsClientHello("Api.Example.COM"))).toEqual({
      status: "ok",
      serverName: "api.example.com",
    });
    expect(parseTlsServerName(tlsClientHello("bad host"))).toEqual({ status: "invalid" });
  });
});

describe("positive read-root sandbox profile", () => {
  it("never emits ambient data or metadata read permission", async () => {
    const worktree = await workspace();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "clankie-positive-runtime-"));
    const prepared = await new ShellSandbox({ platform: "darwin", executable: "/usr/bin/true" }).prepare(
      {
        missionId: "mission-positive-profile",
        taskId: "task-positive-profile",
        workerRunId: "run-positive-profile",
        profileHash: "profile-positive",
        risk: "low",
        workspacePath: worktree,
      },
      { command: "/usr/bin/true", args: [] },
      { PATH: "/usr/bin:/bin" },
      { readableRoots: [runtimeRoot] },
    );
    const profile = prepared.args[1] ?? "";
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(subpath ${JSON.stringify(await realpath(runtimeRoot))})`);
    expect(profile).not.toContain("(allow file-read*)");
    expect(profile).not.toContain("(allow file-read-metadata)");
    expect(profile).toContain("(allow file-read* (");
    await prepared.close();
  });

  it("fails closed when a pnpm runtime dependency symlink leaves its virtual store", async () => {
    const root = await workspace();
    const virtualNodeModules = join(root, "node_modules", ".pnpm", "fixture@1.0.0", "node_modules");
    const packageRoot = join(virtualNodeModules, "fixture");
    const executable = join(packageRoot, "entry.js");
    const outside = await mkdtemp(join(tmpdir(), "clankie-pnpm-escape-"));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(executable, "#!/usr/bin/env node\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    await symlink(outside, join(virtualNodeModules, "escape"));

    await expect(
      new ShellSandbox({ platform: "darwin" }).prepare(
        {
          missionId: "mission-pnpm-escape",
          taskId: "task-pnpm-escape",
          workerRunId: "run-pnpm-escape",
          profileHash: "profile-pnpm-escape",
          risk: "low",
          workspacePath: root,
        },
        { command: executable, args: [] },
        { PATH: process.env.PATH },
        { readableRoots: [root] },
      ),
    ).rejects.toThrow("unexpected entry");
  });
});

describe.skipIf(process.platform !== "darwin")("macOS shell sandbox", () => {
  it("reads declared Pi-style runtime roots but kills arbitrary host reads", async () => {
    const worktree = await workspace();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "clankie-pi-runtime-root-"));
    const outside = await mkdtemp(join(tmpdir(), "clankie-pi-private-home-"));
    const allowedFile = join(runtimeRoot, "runtime.json");
    const privateFile = join(outside, "credential.txt");
    await writeFile(allowedFile, "runtime-ok\n", { mode: 0o600 });
    await writeFile(privateFile, "must-not-read\n", { mode: 0o600 });
    const sandbox = new ShellSandbox();
    const identity = {
      missionId: "mission-pi-positive",
      taskId: "task-pi-positive",
      workerRunId: "run-pi-positive",
      profileHash: "profile-pi-positive",
      risk: "low" as const,
      workspacePath: worktree,
    };
    const prepareRead = (path: string) =>
      sandbox.prepare(
        identity,
        { command: "/bin/cat", args: [path] },
        { PATH: "/usr/bin:/bin" },
        { readableRoots: [runtimeRoot] },
      );

    const allowed = await prepareRead(allowedFile);
    await expect(
      execFileAsync(allowed.command, allowed.args, {
        cwd: worktree,
        env: allowed.environment,
      }),
    ).resolves.toMatchObject({ stdout: "runtime-ok\n" });
    await allowed.close();

    const denied = await prepareRead(privateFile);
    await expect(
      execFileAsync(denied.command, denied.args, {
        cwd: worktree,
        env: denied.environment,
      }),
    ).rejects.toBeDefined();
    await denied.close();
  });

  it("initializes pinned Pi RPC and reaches exact Ollama tags inside positive read roots", async () => {
    const worktree = await workspace();
    const stateRoot = await mkdtemp(join(tmpdir(), "clankie-pi-readiness-state-"));
    const home = join(stateRoot, "home");
    const config = join(stateRoot, "config");
    const sessions = join(stateRoot, "sessions");
    await Promise.all([
      mkdir(join(home, "tmp"), { recursive: true }),
      mkdir(join(home, ".config"), { recursive: true }),
      mkdir(join(home, ".cache"), { recursive: true }),
      mkdir(config),
      mkdir(sessions),
    ]);
    const model = "local-coder:latest";
    const { port } = await listen((request, response) => {
      if (request.url !== "/api/tags") {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: model }] }));
    });
    const ollamaUrl = new URL(`http://127.0.0.1:${String(port)}`);
    await writeFile(
      join(config, "models.json"),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: new URL("/v1", ollamaUrl).toString().replace(/\/$/u, ""),
            api: "openai-completions",
            apiKey: "ollama-local-no-secret",
            models: [{ id: model }],
          },
        },
      }),
    );
    await writeFile(join(config, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
    const nodePathRoot = await executablePathRoot("node");
    const audit = new SqliteEventStore(":memory:");
    const sandbox = new ShellSandbox({
      events: audit,
      decideEscalation: () =>
        Promise.resolve({
          effect: "allow",
          reason: "Fixture permits Pi's exact local model endpoint.",
          matchedPolicyIds: ["test-pi-local-model"],
          obligations: [],
        }),
    });
    const environment = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PI_CODING_AGENT_DIR: config,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      OPENSSL_CONF: "/dev/null",
      TMPDIR: join(home, "tmp"),
      TMP: join(home, "tmp"),
      TEMP: join(home, "tmp"),
    };
    const processPreparer = createPiProcessPreparer({
      sandbox,
      stateRoot,
      readableRoots: [stateRoot, nodePathRoot],
      ollamaUrl,
    });
    await expect(
      probePiBoundary({
        command: resolveBundledPiRpcEntry(),
        environment,
        workspacePath: worktree,
        processPreparer,
        model,
        ollamaUrl,
        sessionRoot: sessions,
      }),
    ).resolves.toBe(true);
    audit.close();
  });

  it("denies host syslog delivery without weakening TCP kill enforcement", async () => {
    const worktree = await workspace();
    const sentinel = `CLANKIE_SYSLOG_DENIAL_${randomUUID()}`;
    const prepared = await new ShellSandbox().prepare(
      {
        missionId: "mission-syslog-denial",
        taskId: "task-syslog-denial",
        workerRunId: "run-syslog-denial",
        profileHash: "profile-syslog-denial",
        risk: "low",
        workspacePath: worktree,
      },
      { command: "/usr/bin/logger", args: [sentinel] },
      { PATH: "/usr/bin:/bin" },
      { readableRoots: [worktree] },
    );
    expect(prepared.args[1]).not.toContain('(allow network-outbound (literal "/private/var/run/syslog"))');
    expect(prepared.args[1]).toContain('(deny network-outbound (literal "/private/var/run/syslog"))');
    expect(prepared.args[1]).toContain("(with send-signal SIGKILL)");
    await expect(
      execFileAsync(prepared.command, prepared.args, { cwd: worktree, env: prepared.environment }),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
    await prepared.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const logs = await execFileAsync("/usr/bin/log", [
      "show",
      "--last",
      "1m",
      "--style",
      "json",
      "--predicate",
      `process == "logger" AND eventMessage == "${sentinel}"`,
    ]);
    expect(logs.stdout).not.toContain(sentinel);
  });

  it("allows worktree writes and returns structured evidence for an outside write denial", async () => {
    const worktree = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "clankie-sandbox-outside-"));
    const events: Array<Omit<DomainEvent, "id" | "occurredAt" | "correlationId">> = [];
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "runner-secret-must-not-enter-worker";
    const worker = new ShellWorkerAdapter({
      id: "shell-sandbox",
      commandForTask: () => ({
        command: "/bin/sh",
        args: [
          "-c",
          `test -z "\${GITHUB_TOKEN+x}"; echo inside > ${JSON.stringify(join(worktree, "inside.txt"))}; { echo outside > ${JSON.stringify(join(outside, "outside.txt"))}; } 2>/dev/null || true; echo masked`,
        ],
      }),
    });

    const result = await worker.run(runContext(worktree, events)).finally(() => {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    });
    expect(result.status).toBe("failed");
    expect(result.evidence).toContainEqual(expect.objectContaining({ label: "sandbox-denial" }));
    expect(events.map((event) => event.type)).toContain("sandbox.denied");
    expect(await readFile(join(worktree, "inside.txt"), "utf8")).toBe("inside\n");
    await expect(readFile(join(outside, "outside.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const spoofed = await new ShellWorkerAdapter({
      id: "shell-sandbox",
      commandForTask: () => ({ command: "/bin/sh", args: ["-c", "echo 'Operation not permitted' >&2"] }),
    }).run(runContext(worktree, []));
    expect(spoofed).toMatchObject({ status: "succeeded", outputs: { stderr: "Operation not permitted\n" } });
  });

  it("blocks direct non-allowlisted network connections", async () => {
    const worktree = await workspace();
    const { port } = await listen((_request, response) => response.end("unexpected"));
    const worker = new ShellWorkerAdapter({
      id: "shell-sandbox",
      commandForTask: () => ({
        command: process.execPath,
        args: [
          "-e",
          `const s=require("node:net").connect(${String(port)},"127.0.0.1");s.on("connect",()=>process.exit(0));s.on("error",e=>{console.error(e.message);process.exit(2)})`,
        ],
      }),
    });

    const result = await worker.run(runContext(worktree, []));
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.outputs)).toContain("force-terminated");
  });

  it("routes exact allowlisted HTTP hosts through the audited localhost proxy", async () => {
    const worktree = await workspace();
    let hits = 0;
    const { port } = await listen((_request, response) => {
      hits += 1;
      response.end("allowed\n");
    });
    const audit = new SqliteEventStore(":memory:");
    const sandbox = new ShellSandbox({
      events: audit,
      decideEscalation: () =>
        Promise.resolve({
          effect: "allow",
          reason: "Fixture permits one exact host.",
          matchedPolicyIds: ["test-network-allow"],
          obligations: [],
        }),
    });
    const worker = new ShellWorkerAdapter({
      id: "shell-sandbox",
      sandbox,
      sandboxForTask: () => ({ networkHosts: ["127.0.0.1"] }),
      commandForTask: () => ({
        command: "/usr/bin/curl",
        args: ["-fsS", `http://127.0.0.1:${String(port)}/`],
      }),
    });

    const result = await worker.run(runContext(worktree, []));
    expect(result).toMatchObject({ status: "succeeded", outputs: { stdout: "allowed\n" } });
    expect(hits).toBe(1);
    const event = (await audit.readAll()).at(-1)?.event;
    expect(event).toMatchObject({
      type: "sandbox.escalation.decided",
      missionId: "mission-sandbox",
      workerRunId: "run-sandbox",
      data: {
        effect: "allow",
        reason: "Fixture permits one exact host.",
        matchedPolicyIds: ["test-network-allow"],
        obligations: [],
      },
    });
    expect(JSON.stringify(event)).not.toContain("127.0.0.1");

    const deniedWorker = new ShellWorkerAdapter({
      id: "shell-sandbox",
      sandbox,
      sandboxForTask: () => ({ networkHosts: ["127.0.0.1"] }),
      commandForTask: () => ({
        command: "/usr/bin/curl",
        args: ["-fsS", `http://localhost:${String(port)}/`],
      }),
    });
    const denied = await deniedWorker.run(runContext(worktree, []));
    expect(denied.status).toBe("failed");
    expect(JSON.stringify(denied.outputs)).toContain("targetFingerprint");
    expect(JSON.stringify(denied.outputs)).not.toContain("localhost");
    expect(hits).toBe(1);
    audit.close();
  });

  it("restricts a network target to its exact host and port", async () => {
    const worktree = await workspace();
    const allowed = await listen((_request, response) => response.end("allowed\n"));
    const deniedTarget = await listen((_request, response) => response.end("must-not-reach\n"));
    const audit = new SqliteEventStore(":memory:");
    const sandbox = new ShellSandbox({
      events: audit,
      decideEscalation: () =>
        Promise.resolve({
          effect: "allow",
          reason: "Fixture permits one exact localhost endpoint.",
          matchedPolicyIds: ["test-network-target"],
          obligations: [],
        }),
    });
    const run = (port: number) =>
      new ShellWorkerAdapter({
        id: "shell-sandbox",
        sandbox,
        sandboxForTask: () => ({ networkTargets: [{ host: "127.0.0.1", port: allowed.port }] }),
        commandForTask: () => ({
          command: "/usr/bin/curl",
          args: ["-fsS", `http://127.0.0.1:${String(port)}/`],
        }),
      }).run(runContext(worktree, []));

    await expect(run(allowed.port)).resolves.toMatchObject({ status: "succeeded" });
    await expect(run(deniedTarget.port)).resolves.toMatchObject({ status: "failed" });
    const serialized = JSON.stringify(await audit.readAll());
    expect(serialized).not.toContain(String(allowed.port));
    expect(serialized).not.toContain("127.0.0.1");
    audit.close();
  });

  it("reserves the Seatbelt proxy port on both loopback families", async () => {
    const worktree = await workspace();
    const allowed = await listen((_request, response) => response.end("allowed\n"));
    let deniedHits = 0;
    const denied = await listen((_request, response) => {
      deniedHits += 1;
      response.end("must-not-reach\n");
    });
    const audit = new SqliteEventStore(":memory:");
    const sandbox = new ShellSandbox({
      events: audit,
      decideEscalation: () =>
        Promise.resolve({
          effect: "allow",
          reason: "Fixture permits one exact localhost endpoint.",
          matchedPolicyIds: ["test-loopback-family-reservation"],
          obligations: [],
        }),
    });
    const prepared = await sandbox.prepare(
      {
        missionId: "mission-loopback-family",
        taskId: "task-loopback-family",
        workerRunId: "run-loopback-family",
        profileHash: "profile-loopback-family",
        risk: "low",
        workspacePath: worktree,
      },
      {
        command: process.execPath,
        args: [
          "-e",
          `const http=require("node:http");const request=http.request({host:"127.0.0.1",port:Number(process.env.PROXY_PORT),path:process.env.DENIED_URL},response=>process.exit(response.statusCode===403?0:3));request.on("error",()=>process.exit(4));request.end();`,
        ],
      },
      { PATH: process.env.PATH },
      { networkTargets: [{ host: "127.0.0.1", port: allowed.port }] },
    );
    const proxyUrl = prepared.environment.HTTP_PROXY;
    if (!proxyUrl) throw new Error("Sandbox proxy URL missing");
    const proxyPort = Number(new URL(proxyUrl).port);

    const collision = createServer((_request, response) => response.end("bypass\n"));
    let collisionBound = false;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        collision.once("error", reject);
        collision.listen(proxyPort, "127.0.0.1", () => resolvePromise());
      });
      collisionBound = true;
    } catch (error) {
      expect(error).toMatchObject({ code: "EADDRINUSE" });
    } finally {
      if (collisionBound)
        await new Promise<void>((resolvePromise) => collision.close(() => resolvePromise()));
    }
    expect(collisionBound).toBe(false);

    prepared.environment.PROXY_PORT = String(proxyPort);
    prepared.environment.DENIED_URL = `http://127.0.0.1:${String(denied.port)}/`;
    await expect(
      execFileAsync(prepared.command, prepared.args, {
        cwd: worktree,
        env: prepared.environment,
        timeout: 5_000,
      }),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
    expect(deniedHits).toBe(0);
    await prepared.close();
    audit.close();
  });

  it.each([
    { effect: "require_approval" as const, obligations: [] },
    { effect: "allow" as const, obligations: ["unsupported-fixture-obligation"] },
  ])("fails a non-executable doctrine decision before execution", async ({ effect, obligations }) => {
    const worktree = await workspace();
    const audit = new SqliteEventStore(":memory:");
    const sandbox = new ShellSandbox({
      events: audit,
      decideEscalation: () =>
        Promise.resolve({
          effect,
          reason: "Fixture decision cannot execute.",
          matchedPolicyIds: ["sandbox:default"],
          obligations,
        }),
    });
    const worker = new ShellWorkerAdapter({
      id: "shell-sandbox",
      sandbox,
      sandboxForTask: () => ({ networkHosts: ["example.com"] }),
      commandForTask: () => ({ command: "/usr/bin/true", args: [] }),
    });

    const result = await worker.run(runContext(worktree, []));
    expect(result.status).toBe("failed");
    expect((await audit.readAll()).at(-1)?.event).toMatchObject({
      type: "sandbox.escalation.decided",
      data: { effect, obligations },
    });
    audit.close();
  });
});

async function executablePathRoot(command: string): Promise<string> {
  for (const root of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      await access(join(root, command), constants.X_OK);
      return realpath(root);
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error(`Missing ${command} PATH root`);
}
