import { execFile as execFileCallback, type spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { HEADLESS_NOUNS } from "../src/command/registry.ts";

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
  it("does not project stored Discord settings back as environment overrides for config commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-command-"));
    tempDirs.push(root);
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, activeBody: "user_session", userSessionEnabled: true },
    }));

    const result = await execFileAsync(
      process.execPath,
      [resolve(import.meta.dirname, "../bin/clankie.ts"), "discord", "status"],
      {
        env: {
          ...process.env,
          CLANKIE_SETTINGS_FILE: settings.path,
          DISCORD_ACTIVE_BODY: "",
          DISCORD_USER_SESSION_ENABLED: "",
        },
      },
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      discord: { activeBody: "user_session", userSessionEnabled: true },
      effectiveDiscord: { activeBody: "user_session", userSessionEnabled: true },
      overriddenByEnvironment: [],
    });
  });

  it("prints a self-contained command index on help", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exitCode = await runHeadlessCaptainCommand(["help"], {
      repoRoot: "/unused",
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const help = stdout.text();
    for (const noun of HEADLESS_NOUNS) {
      expect(help).toContain(noun);
    }
    for (const token of [
      "--json",
      "--timeout",
      "revoke",
      "play status",
      "play stop",
      "model add-local",
      "--set",
      "--models",
      "/v1",
      "docs/cli.md",
      "/auth",
    ]) {
      expect(help).toContain(token);
    }
  });

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
      ["relay", "healthy", false],
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
    // Each HTTP-probed service reports down until its own spawn lands; the
    // bridge probe is record-backed, so it turns healthy once its spawn lands.
    let clankieUp = false;
    let relayUp = false;

    const exitCode = await runHeadlessCaptainCommand(["restart", "captain"], {
      repoRoot: "/repo",
      env: await stateEnv(),
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes(":4321/health")) {
          if (!relayUp) throw new Error("connection refused");
          return Response.json({ ok: true });
        }
        if (url.includes("/health")) {
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
        if (args.includes("@clankie/relay")) relayUp = true;
        return runningChild(9_000 + spawned.length);
      }) as unknown as typeof spawn,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    // The captain restart fans out to the relay holding its bearer and the
    // bridge, whose live presence claim the restarted service no longer honors.
    expect(spawned.map((args) => args[1])).toEqual([
      "@clankie/clankie",
      "@clankie/relay",
      "@clankie/discord-bridge",
    ]);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      status: "ready",
      owned: true,
      target: "clankie",
      services: [
        { id: "clankie", ok: true },
        { id: "relay", ok: true },
        { id: "discord-bridge", ok: true },
      ],
    });
    // Progress narration must stay off stdout so it remains a JSON document.
    expect(stderr.text()).toContain("Clankie");
  });

  it("defers a restart requested by the active operator turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-restart-handoff-"));
    tempDirs.push(root);
    const piDirectory = join(root, "global-default", "pi");
    await mkdir(piDirectory, { recursive: true });
    const sessionFile = join(piDirectory, "session.jsonl");
    const eventsPath = join(root, "global-default", "events.jsonl");
    await writeFile(sessionFile, "");
    await writeFile(
      eventsPath,
      `${JSON.stringify({ type: "turn", runId: "run-active", phase: "accepted" })}\n`,
    );
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const spawns: Array<{ readonly command: string; readonly args: readonly string[] }> = [];

    const exitCode = await runHeadlessCaptainCommand(["restart", "captain"], {
      repoRoot: "/repo",
      env: {
        ...(await stateEnv()),
        PI_SESSION_FILE: sessionFile,
        CLANKIE_LAUNCHER_PATH: "/release/bin/clankie",
      },
      spawnImpl: ((command: string, args: string[]) => {
        spawns.push({ command, args });
        return runningChild(9_100);
      }) as unknown as typeof spawn,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      status: "scheduled",
      target: "clankie",
      afterRun: "run-active",
    });
    expect(stderr.text()).toContain("after this conversation turn completes");
    expect(spawns).toEqual([
      {
        command: "/release/bin/clankie",
        args: ["restart", "clankie", "--after-operator-turn", eventsPath, "run-active"],
      },
    ]);
  });

  it("prints a secret-free install card without probing the live PATH", async () => {
    const stdout = outputBuffer();
    const root = await mkdtemp(join(tmpdir(), "clankie-doctor-cmd-"));
    tempDirs.push(root);
    await writeFile(join(root, "package.json"), `${JSON.stringify({ version: "0.2.0" })}\n`);

    const exitCode = await runHeadlessCaptainCommand(["doctor"], {
      repoRoot: root,
      env: {
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
      },
      execFileImpl: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      kind: "checkout",
      version: "0.2.0",
      repoRoot: root,
      model: null,
    });
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
