import { execFile as execFileCallback, type spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";

const execFileAsync = promisify(execFileCallback);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

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

/** A detached child that stays alive, like a real service. */
function runningChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    pid,
    kill: () => true,
    unref: () => {},
  }) as unknown as ChildProcess;
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

/** Healthy clankie service + activity; nothing else running. */
function healthyFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ ok: true, service: "clankie" });
  }) as typeof fetch;
}

describe("headless clankie commands", () => {
  it("probes the single service health route without starting anything", async () => {
    const calls: string[] = [];
    const stdout = outputBuffer();

    const exitCode = await runHeadlessCaptainCommand(["health"], {
      repoRoot: "/unused",
      env: await stateEnv(),
      fetchImpl: healthyFetch(calls),
      // Otherwise the bridge probe reads the real process table, and a developer
      // with a live bridge sees "healthy" where CI sees "unreachable".
      listProcessCommandsImpl: () => [],
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    // The clankie service is probed exactly once through its health route. The
    // bridge's presence detail legitimately rides the same port; what must not
    // regress is a duplicate health round trip.
    const servicePaths = calls
      .map((url) => new URL(url))
      .filter((url) => url.port === "4310")
      .map((url) => url.pathname);
    expect(servicePaths.filter((path) => path === "/health")).toEqual(["/health"]);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      status: "ready",
      host: "http://127.0.0.1:4310",
      operatorCredential: { present: true, source: "env", consistency: "env_only" },
    });
    // Status reports every supervised service in dependency order. The bridge
    // has no process behind it in this fixture, and nothing is launcher-owned.
    const { services } = JSON.parse(stdout.text()) as {
      services: readonly { id: string; state: string; owned: boolean }[];
    };
    expect(services.map((service) => [service.id, service.state, service.owned])).toEqual([
      ["clankie", "healthy", false],
      ["discord-bridge", "unreachable", false],
      ["discord-user-session", "healthy", false],
      // The surfaces an audience actually reaches are reported too — health
      // used to stop at the bridge, which is how a dead tunnel stayed invisible.
      ["activity", "healthy", false],
      ["tunnel", "healthy", false],
    ]);
    // No tunnel configured in this fixture, and that is not a fault to report.
    expect(services.find((service) => service.id === "tunnel")).toMatchObject({
      state: "healthy",
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
      env: { XDG_STATE_HOME: root, CLANKIE_OPERATOR_TOKEN: overridden },
      fetchImpl: healthyFetch(),
      listProcessCommandsImpl: () => [],
      operatorCredentialStore: store,
      captainCredentialStore: store,
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

  it("routes a captain-scoped restart through the single service without a TTY face", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const spawned: string[][] = [];
    // The service reports down until it is spawned, then healthy; the bridge
    // probe is record-backed, so it turns healthy once its own spawn lands.
    let clankieUp = false;

    const exitCode = await runHeadlessCaptainCommand(["restart", "captain"], {
      repoRoot: "/repo",
      env: await stateEnv(),
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).includes("/health")) {
          if (!clankieUp) throw new Error("connection refused");
          return Response.json({ ok: true });
        }
        throw new Error("connection refused");
      }) as typeof fetch,
      listProcessCommandsImpl: () => [],
      processIsAliveImpl: () => true,
      spawnImpl: ((_command: string, args: string[]) => {
        spawned.push(args);
        if (args.includes("@clankie/clankie")) clankieUp = true;
        return runningChild(9_000 + spawned.length);
      }) as unknown as typeof spawn,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    // The captain restart fans out to the bridge, whose live presence claim the
    // restarted service no longer honors.
    expect(spawned.map((args) => args[1])).toEqual(["@clankie/clankie", "@clankie/discord-bridge"]);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      status: "ready",
      owned: true,
      target: "clankie",
      services: [
        { id: "clankie", ok: true },
        { id: "discord-bridge", ok: true },
        { id: "discord-user-session", ok: true },
      ],
    });
    // Progress narration must stay off stdout so it remains a JSON document.
    expect(stderr.text()).toContain("Clankie");
  });

  it("rejects an unknown restart target without signalling anything", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    let spawnedAnything = false;

    const exitCode = await runHeadlessCaptainCommand(["restart", "not-a-service"], {
      repoRoot: "/repo",
      env: await stateEnv(),
      spawnImpl: (() => {
        spawnedAnything = true;
        throw new Error("must not spawn on an unknown target");
      }) as unknown as typeof spawn,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(spawnedAnything).toBe(false);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain('Unknown service "not-a-service"');
  });

  it("routes the real executable health command without a TTY", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, service: "clankie" }));
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test server address");
      const repoRoot = resolve(import.meta.dirname, "../../..");
      const processStateRoot = await mkdtemp(join(tmpdir(), "clankie-headless-process-test-"));
      tempDirs.push(processStateRoot);
      const { stdout } = await execFileAsync(
        process.execPath,
        [join(repoRoot, "apps", "tui", "bin", "clankie.ts"), "health"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
            CLANKIE_CREDENTIALS_FILE: join(processStateRoot, "credentials.json"),
            CLANKIE_OPERATOR_TOKEN: "operator-secret",
            XDG_STATE_HOME: processStateRoot,
          },
        },
      );
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, status: "ready" });
      expect(paths).toContain("/health");
    } finally {
      server.close();
    }
  });
});
