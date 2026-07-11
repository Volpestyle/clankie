import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@sapling/event-store";
import type { DomainEvent } from "@sapling/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { parseTlsServerName, ShellSandbox } from "../src/sandbox.ts";
import { ShellWorkerAdapter } from "../src/shell-worker.ts";

const servers: Server[] = [];

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
  return mkdtemp(join(tmpdir(), "sapling-sandbox-work-"));
}

function runContext(path: string, events: Array<Omit<DomainEvent, "id" | "occurredAt" | "correlationId">>) {
  return {
    missionId: "mission-sandbox",
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

describe.skipIf(process.platform !== "darwin")("macOS shell sandbox", () => {
  it("allows worktree writes and returns structured evidence for an outside write denial", async () => {
    const worktree = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "sapling-sandbox-outside-"));
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
      workerRunId: "mission-sandbox:task-sandbox:attempt-1",
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
