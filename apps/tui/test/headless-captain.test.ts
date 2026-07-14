import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import type { Client, HandleMessageStreamEvent, SessionState } from "eve/client";
import { afterEach, describe, expect, it } from "vitest";
import { headlessCaptainCursorPath, runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import type { CaptainServiceHandle } from "../bin/captain-service.ts";
import {
  CAPTAIN_AGENT_NAME,
  CAPTAIN_AUTHORED_TOOL_NAMES,
  CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES,
  EVE_WORKFLOW_ID,
} from "../src/session/captain-identity.ts";
import { CaptainSessionCursorStore } from "../src/session/session-cursor.ts";

const execFileAsync = promisify(execFileCallback);
const tempDirs: string[] = [];
const TEST_GENERATION = "a".repeat(64);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function captainInfo(): unknown {
  return {
    kind: "eve-agent-info",
    mode: "start",
    agent: {
      name: CAPTAIN_AGENT_NAME,
      agentRoot: "/captain/agent",
      appRoot: "/captain/app",
    },
    tools: {
      authored: CAPTAIN_AUTHORED_TOOL_NAMES.map((name) => ({ name })),
      available: CAPTAIN_AUTHORED_TOOL_NAMES.map((name) => ({ name })),
      disabledFramework: [...CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES],
    },
  };
}

function healthyFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return String(input).endsWith("/eve/v1/info")
      ? Response.json(captainInfo())
      : Response.json({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID });
  }) as typeof fetch;
}

function outputBuffer(): { readonly stream: { write(chunk: string): void }; readonly text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += chunk;
      },
    },
    text: () => output,
  };
}

function captainHandle(host: string): CaptainServiceHandle {
  return {
    generation: TEST_GENERATION,
    host,
    owned: false,
    stop: () => Promise.resolve(),
    stopSync: () => undefined,
  };
}

function fakeClient(input: {
  readonly events?: readonly HandleMessageStreamEvent[];
  readonly onSend?: (message: string) => void;
  readonly onStream?: (state: SessionState, startIndex: number | undefined) => void;
  readonly streamImpl?: (signal: AbortSignal | undefined) => AsyncIterable<HandleMessageStreamEvent>;
}): Client {
  return {
    health: async () => ({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID }),
    info: async () => captainInfo(),
    session: (state: SessionState = { streamIndex: 0 }) => ({
      send: async (payload: { message?: string }) => {
        input.onSend?.(payload.message ?? "");
        return {
          continuationToken: "continuation-private",
          sessionId: state.sessionId ?? "headless-session",
        };
      },
      stream: (options?: { signal?: AbortSignal; startIndex?: number }) => {
        input.onStream?.(state, options?.startIndex);
        if (input.streamImpl !== undefined) return input.streamImpl(options?.signal);
        return (async function* () {
          for (const event of input.events ?? []) yield event;
        })();
      },
    }),
  } as unknown as Client;
}

async function stateEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-headless-test-"));
  tempDirs.push(root);
  return {
    XDG_STATE_HOME: root,
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    CLANKIE_OPERATOR_TOKEN: "operator-secret",
  };
}

async function writeServiceRecord(env: NodeJS.ProcessEnv, host: string): Promise<void> {
  const directory = join(env.XDG_STATE_HOME as string, "clankie");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "captain-eve-service.json"),
    `${JSON.stringify({
      version: 1,
      host,
      generation: TEST_GENERATION,
      pid: process.pid,
    })}\n`,
  );
}

describe("headless captain commands", () => {
  it("uses the canonical health and info endpoints without starting the captain", async () => {
    const calls: string[] = [];
    const stdout = outputBuffer();
    let ensureCalled = false;

    const exitCode = await runHeadlessCaptainCommand(["health"], {
      repoRoot: "/unused",
      env: await stateEnv(),
      fetchImpl: healthyFetch(calls),
      ensureImpl: async () => {
        ensureCalled = true;
        throw new Error("health must not start the captain");
      },
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    expect(ensureCalled).toBe(false);
    expect(calls.map((url) => new URL(url).pathname)).toEqual(["/eve/v1/health", "/eve/v1/info"]);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      status: "ready",
      endpointState: "healthy",
      healthPath: "/eve/v1/health",
      infoPath: "/eve/v1/info",
      operatorCredential: { present: true, source: "env", consistency: "env_only" },
    });
  });

  it("diagnoses an env/store mismatch without printing either credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-health-credential-"));
    tempDirs.push(root);
    const store = new FileCredentialStore(join(root, "credentials.json"));
    const stored = mintOperatorToken();
    const overridden = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: stored });
    const stdout = outputBuffer();

    const exitCode = await runHeadlessCaptainCommand(["health"], {
      repoRoot: "/unused",
      env: { CLANKIE_OPERATOR_TOKEN: overridden },
      fetchImpl: healthyFetch(),
      operatorCredentialStore: store,
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      status: "operator_credential_mismatch",
      operatorCredential: { present: true, source: "env", consistency: "mismatch" },
    });
    expect(stdout.text()).not.toContain(stored);
    expect(stdout.text()).not.toContain(overridden);
  });

  it("rotates the stored operator credential without rendering the old or new secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-rotate-credential-"));
    tempDirs.push(root);
    const store = new FileCredentialStore(join(root, "credentials.json"));
    const original = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: original });
    const stdout = outputBuffer();

    const exitCode = await runHeadlessCaptainCommand(["operator-credential", "rotate", "--json"], {
      repoRoot: "/unused",
      env: {},
      operatorCredentialStore: store,
      stdout: stdout.stream,
    });
    const rotated = await store.get(OPERATOR_CREDENTIAL_PROVIDER_ID);

    expect(exitCode).toBe(0);
    expect(rotated?.type).toBe("api");
    expect(rotated?.type === "api" ? rotated.key : undefined).not.toBe(original);
    expect(JSON.parse(stdout.text())).toEqual({ ok: true, status: "rotated", source: "store" });
    expect(stdout.text()).not.toContain(original);
    if (rotated?.type === "api") expect(stdout.text()).not.toContain(rotated.key);
  });

  it("routes restart without initializing the TTY face", async () => {
    const stdout = outputBuffer();
    const host = "http://127.0.0.1:4321";
    let restarted = false;

    const exitCode = await runHeadlessCaptainCommand(["restart"], {
      repoRoot: "/repo",
      env: await stateEnv(),
      host,
      restartImpl: async () => {
        restarted = true;
        return { ...captainHandle(host), owned: true };
      },
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    expect(restarted).toBe(true);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, status: "ready", owned: true });
  });

  it("submits a message without echoing it and writes a private isolated cursor", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    const stdout = outputBuffer();
    const secretPrompt = "coordinate the next private mission";
    let delivered: string | undefined;

    const exitCode = await runHeadlessCaptainCommand(["msg", secretPrompt], {
      repoRoot: "/repo",
      env,
      host,
      ensureImpl: async () => captainHandle(host),
      clientFactory: () =>
        fakeClient({
          onSend: (message) => {
            delivered = message;
          },
        }),
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    expect(delivered).toBe(secretPrompt);
    expect(stdout.text()).not.toContain(secretPrompt);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      status: "submitted",
      sessionId: "headless-session",
      next: "clankie watch",
    });
    const path = headlessCaptainCursorPath(env);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      active: true,
      generation: TEST_GENERATION,
      sessionId: "headless-session",
      streamIndex: 0,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("reads a non-TTY message from stdin", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    let delivered: string | undefined;

    const exitCode = await runHeadlessCaptainCommand(["msg"], {
      repoRoot: "/repo",
      env,
      host,
      readStdin: async () => "message from pipe\n",
      ensureImpl: async () => captainHandle(host),
      clientFactory: () =>
        fakeClient({
          onSend: (message) => {
            delivered = message;
          },
        }),
      stdout: outputBuffer().stream,
    });

    expect(exitCode).toBe(0);
    expect(delivered).toBe("message from pipe\n");
  });

  it("streams from the durable index exactly once and settles the cursor", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    await writeServiceRecord(env, host);
    const store = new CaptainSessionCursorStore(headlessCaptainCursorPath(env));
    await store.write({
      version: 2,
      active: true,
      generation: TEST_GENERATION,
      sessionId: "headless-session",
      continuationToken: "continuation-private",
      streamIndex: 3,
    });
    const events = [
      { type: "message.completed", data: { message: "done", sequence: 3, stepIndex: 0, turnId: "t" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ] as unknown as HandleMessageStreamEvent[];
    const stdout = outputBuffer();
    let observedStart: number | undefined;

    const exitCode = await runHeadlessCaptainCommand(["watch"], {
      repoRoot: "/repo",
      env,
      host,
      clientFactory: () =>
        fakeClient({
          events,
          onStream: (_state, startIndex) => {
            observedStart = startIndex;
          },
        }),
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    expect(observedStart).toBe(3);
    expect(stdout.text()).toContain('"type":"message.completed"');
    expect(stdout.text()).toContain('"status":"waiting"');
    expect(await store.read()).toMatchObject({ active: false, streamIndex: 5 });
  });

  it("wait suppresses intermediate events and prints only the final boundary", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    await writeServiceRecord(env, host);
    await new CaptainSessionCursorStore(headlessCaptainCursorPath(env)).write({
      version: 2,
      active: true,
      generation: TEST_GENERATION,
      sessionId: "headless-session",
      streamIndex: 0,
    });
    const stdout = outputBuffer();

    const exitCode = await runHeadlessCaptainCommand(["wait"], {
      repoRoot: "/repo",
      env,
      host,
      clientFactory: () =>
        fakeClient({
          events: [
            { type: "message.appended", data: { messageDelta: "x", messageSoFar: "x" } },
            { type: "session.completed" },
          ] as unknown as HandleMessageStreamEvent[],
        }),
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, status: "completed" });
  });

  it("returns 124 on an explicit watch timeout and preserves the active cursor", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    await writeServiceRecord(env, host);
    const store = new CaptainSessionCursorStore(headlessCaptainCursorPath(env));
    await store.write({
      version: 2,
      active: true,
      generation: TEST_GENERATION,
      sessionId: "headless-session",
      streamIndex: 2,
    });
    const stderr = outputBuffer();

    const exitCode = await runHeadlessCaptainCommand(["watch", "--timeout", "0.01"], {
      repoRoot: "/repo",
      env,
      host,
      clientFactory: () =>
        fakeClient({
          streamImpl: (signal) =>
            (async function* () {
              await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                  once: true,
                });
              });
              yield { type: "session.completed" } as HandleMessageStreamEvent;
            })(),
        }),
      stdout: outputBuffer().stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(124);
    expect(JSON.parse(stderr.text())).toMatchObject({ status: "timeout" });
    expect(await store.read()).toMatchObject({ active: true, streamIndex: 2 });
  });

  it("refuses a second message while the saved turn is active", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    await new CaptainSessionCursorStore(headlessCaptainCursorPath(env)).write({
      version: 2,
      active: true,
      generation: TEST_GENERATION,
      sessionId: "headless-session",
      streamIndex: 0,
    });
    const stderr = outputBuffer();

    const exitCode = await runHeadlessCaptainCommand(["msg", "must not send"], {
      repoRoot: "/repo",
      env,
      host,
      ensureImpl: async () => captainHandle(host),
      clientFactory: () => fakeClient({ onSend: () => expect.unreachable() }),
      stdout: outputBuffer().stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("clankie watch");
  });

  it("routes the real executable health command without a TTY", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/eve/v1/info"
            ? captainInfo()
            : { ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID },
        ),
      );
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test server address");
      const repoRoot = resolve(import.meta.dirname, "../../..");
      const processStateRoot = await mkdtemp(join(tmpdir(), "clankie-headless-process-test-"));
      tempDirs.push(processStateRoot);
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [join(repoRoot, "apps", "tui", "bin", "clankie.ts"), "health"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CLANKIE_CAPTAIN_URL: `http://127.0.0.1:${address.port}`,
            CLANKIE_CREDENTIALS_FILE: join(processStateRoot, "credentials.json"),
            CLANKIE_OPERATOR_TOKEN: "operator-secret",
            XDG_STATE_HOME: processStateRoot,
          },
        },
      );
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, status: "ready", endpointState: "healthy" });
      expect(paths).toEqual(["/eve/v1/health", "/eve/v1/info"]);
    } finally {
      server.close();
    }
  });
});
