import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
  symlinkSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { createRuntimeUpdater, updateHoldingServices } from "../bin/runtime-updater.ts";
import { writeRuntimeUpdate, runtimeUpdateServices } from "../bin/runtime-update.ts";
import { createRuntimeUpdateRoutes } from "../../clankie/src/runtime-update-routes.ts";
import { runUpdateCommand } from "../src/command/update.ts";
import { runDownCommand, runRestartCommand, runStartCommand } from "../src/command/restart.ts";
import { inspectService, listProcessCommands } from "../bin/service-supervisor.ts";
import { managedService, stopTarget } from "../bin/services.ts";

import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { ClankieSettingsSchema } from "@clankie/settings";
import { text } from "node:stream/consumers";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const authority = {
  guard: async () => {},
  current: () => true,
  initiator: { kind: "conversation" as const, conversationId: "owner-conversation" },
};
function fixture(pinLatest = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clankie-update-git-")));
  roots.push(home);
  const origin = join(home, "origin.git"),
    publisher = join(home, "publisher"),
    source = join(home, "source"),
    runtime = join(home, ".clankie/pinned");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(home, "init", "--bare", origin);
  git(home, "init", "-b", "main", publisher);
  git(publisher, "config", "user.name", "Update fixture");
  git(publisher, "config", "user.email", "fixture@example.test");
  const commit = (value: string) => {
    writeFileSync(join(publisher, "content"), value);
    git(publisher, "add", "content");
    git(publisher, "commit", "-m", value);
    return git(publisher, "rev-parse", "HEAD");
  };
  const old = commit("old");
  git(publisher, "remote", "add", "origin", origin);
  git(publisher, "push", "origin", "main");
  git(home, "clone", "-b", "main", origin, source);
  const latest = commit("remote repair");
  git(publisher, "push", "origin", "main");
  mkdirSync(join(home, ".clankie"), { mode: 0o700 });
  if (pinLatest) git(source, "fetch", "origin");
  git(source, "worktree", "add", "--detach", runtime, pinLatest ? latest : old);
  const launches: unknown[] = [];
  const updater = createRuntimeUpdater({
    repoRoot: runtime,
    env: { HOME: home },
    spawnHelper: (...args) => {
      launches.push(args);
      return Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess;
    },
  });
  return { home, origin, publisher, source, runtime, git, old, latest, updater, launches };
}
it("fetches origin/main rather than a stale or diverged local main and journals the caller", async () => {
  const f = fixture();
  f.git(f.source, "config", "user.name", "Local owner");
  f.git(f.source, "config", "user.email", "owner@example.test");
  writeFileSync(join(f.source, "content"), "local divergence");
  f.git(f.source, "commit", "-am", "local divergence");
  expect(f.git(f.source, "rev-parse", "origin/main")).toBe(f.old);
  const local = f.git(f.source, "rev-parse", "main");
  const result = await f.updater.request("main", authority);
  expect(result).toMatchObject({
    accepted: true,
    latest: {
      oldCommit: f.old,
      newCommit: f.latest,
      resolvedRef: "refs/remotes/origin/main",
      initiator: authority.initiator,
    },
  });
  expect(result.latest?.warning).toBeUndefined();
  expect(f.git(f.source, "rev-parse", "main")).toBe(local);
  expect(f.git(f.runtime, "rev-parse", "HEAD")).toBe(f.old);
  const plan = JSON.parse(
    readFileSync(join(f.home, ".clankie/updates", result.pending!, "plan.json"), "utf8"),
  );
  expect(plan).toMatchObject({ newCommit: f.latest, initiator: authority.initiator });
  expect(
    JSON.parse(readFileSync(join(f.home, ".clankie/updates", result.pending!, "helper.log"), "utf8")),
  ).toMatchObject({ event: "runtime-update-accepted", newCommit: f.latest, initiator: authority.initiator });
  expect(f.launches).toHaveLength(1);
});
it("refuses failed fetches without falling back to a cached branch or accepting an operation", async () => {
  const f = fixture();
  f.git(f.source, "remote", "set-url", "origin", join(f.home, "missing-origin"));
  await expect(f.updater.request("main", authority)).rejects.toThrow();
  expect(f.launches).toHaveLength(0);
  expect(f.updater.status().pending).toBeUndefined();
  expect(f.git(f.runtime, "rev-parse", "HEAD")).toBe(f.old);
});
it("reports an explicit older SHA and preserves the warning in failed status", async () => {
  const f = fixture(true);
  const accepted = await f.updater.request(f.old, authority);
  expect(accepted.latest).toMatchObject({
    newCommit: f.old,
    oldCommit: f.latest,
    warning: "older-than-current-pin",
  });
  writeRuntimeUpdate(join(f.home, ".clankie/updates", accepted.pending!), {
    ...accepted.latest!,
    phase: "failed",
    reason: "pre-cutover-failed",
  });
  expect(f.updater.status().latest).toMatchObject({
    newCommit: f.old,
    warning: "older-than-current-pin",
    phase: "failed",
  });
});
it("retains the canary-held operation with newer result evidence while rejecting malformed known canary metadata", async () => {
  const f = fixture();
  const accepted = await f.updater.request("main", authority);
  const path = join(f.home, ".clankie/updates", accepted.pending!, "result.json");
  const evidence = {
    ...accepted.latest,
    phase: "healthy",
    healthy: true,
    newerEvidence: { ok: true },
    canary: { state: "pending", holdId: accepted.pending, holdEstablished: true },
  };
  writeFileSync(path, JSON.stringify(evidence), { mode: 0o600 });
  expect(f.updater.status()).toMatchObject({
    runtime: { commit: f.old },
    pending: accepted.pending,
    latest: {
      resolvedRef: "refs/remotes/origin/main",
      initiator: authority.initiator,
      canary: evidence.canary,
    },
  });
  expect(await f.updater.request("main", authority)).toMatchObject({
    accepted: false,
    pending: accepted.pending,
    latest: { canary: evidence.canary },
  });
  expect(f.launches).toHaveLength(1);
  writeFileSync(
    path,
    JSON.stringify({ ...evidence, canary: { ...evidence.canary, holdEstablished: "yes" } }),
    { mode: 0o600 },
  );
  expect(f.updater.status()).toMatchObject({ error: "update_record_unreadable", needsReconciliation: true });
  expect(existsSync(join(f.home, ".clankie/updates/active"))).toBe(true);
  await expect(f.updater.request("main", authority)).rejects.toThrow("Invalid runtime canary hold");
  expect(f.launches).toHaveLength(1);
});
it("CLI status stays JSON across newer evidence, damaged records and a non-JSON legacy server error", async () => {
  const f = fixture();
  const accepted = await f.updater.request("main", authority);
  const directory = join(f.home, ".clankie/updates", accepted.pending!);
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({
      ...accepted.latest,
      phase: "failed",
      reason: "pre-cutover-failed",
      newerEvidence: { ok: true },
      harnessRefresh: { ok: false },
    }),
    { mode: 0o600 },
  );
  const app = createRuntimeUpdateRoutes({ updater: f.updater, authorize: async () => authority });
  app.get("/legacy", (c) => c.text("Internal Server Error", 500));
  const server = createHttpServer(async (incoming, outgoing) => {
    const response = await app.fetch(
      new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method ?? "GET" }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const options = {
    host: `http://127.0.0.1:${address.port}`,
    env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
  };
  try {
    expect(await runUpdateCommand(["status"], options)).toMatchObject({
      latest: { phase: "failed", harnessRefresh: { ok: false } },
    });
    writeFileSync(join(directory, "result.json"), "broken JSON", { mode: 0o600 });
    expect(await runUpdateCommand(["status"], options)).toMatchObject({
      error: "update_record_unreadable",
      needsReconciliation: true,
    });
    expect(existsSync(join(f.home, ".clankie/updates/active"))).toBe(true);
    await expect(f.updater.request("main", authority)).rejects.toThrow();
    expect(
      await runUpdateCommand(["status"], {
        ...options,
        fetchImpl: (input, init) => fetch(new URL("/legacy", String(input)), init),
      }),
    ).toMatchObject({ error: "update_response_unreadable", status: 500 });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it("audits the CLI initiating operator and labels environment attribution as claims through actual HTTP", async () => {
  const f = fixture();
  const service = await createClankieApp({
    captain: createStubCaptain(),
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(f.home, "events.jsonl"),
    runtimeUpdater: f.updater,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner"
        ? { operatorId: "owner-id" }
        : undefined,
  });
  const server = createHttpServer(async (request, response) => {
    const body = await text(request);
    const result = await service.app.request(request.url!, {
      method: request.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(",") : (value ?? ""),
        ]),
      ),
      ...(body ? { body } : {}),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture address");
  try {
    expect(
      await runUpdateCommand([], {
        host: `http://127.0.0.1:${address.port}`,
        env: {
          CLANKIE_OPERATOR_TOKEN: "fixture-owner",
          CLANKIE_CONVERSATION_ID: "caller-conversation",
          CLANKIE_SEAT_SESSION_ID: "caller-seat-session",
        },
      }),
    ).toMatchObject({
      accepted: true,
      latest: {
        newCommit: f.latest,
        initiator: {
          kind: "cli",
          operatorId: "owner-id",
          claimedConversationId: "caller-conversation",
          claimedSeatSessionId: "caller-seat-session",
        },
      },
    });
    expect(f.updater.status().latest?.initiator?.conversationId).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
  }
});

async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
it("cuts over isolated launcher services while a real unowned activity tunnel survives", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clankie-update-services-")));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    CLANKIE_STATE_HOME: join(root, "state"),
    PI_SESSION_FILE: "",
    PORT: String(await port()),
    CLANKIE_RELAY_PORT: String(await port()),
    CLANKIE_ACTIVITY_PORT: String(await port()),
    CLANKIE_ACTIVITY_PRODUCER_PORT: String(await port()),
    CLANKIE_OPERATOR_TOKEN: "fixture-owner",
    CLANKIE_CAPTAIN_TOKEN: "fixture-captain",
    CLANKIE_ACTIVITY_TUNNEL_NAME: "fixture-tunnel",
    CLANKIE_KEEP_AWAKE: "0",
    DISCORD_ACTIVE_BODY: "bot",
    DISCORD_USER_SESSION_ENABLED: "false",
  };
  env.CLANKIE_CONTROL_PLANE_URL = `http://127.0.0.1:${env.PORT}`;
  mkdirSync(join(root, "libexec"), { recursive: true });
  symlinkSync(process.execPath, join(root, "libexec/node"));
  for (const [name, listenPort] of [
    ["clankie", env.PORT],
    ["relay", env.CLANKIE_RELAY_PORT],
    ["discord-activity", env.CLANKIE_ACTIVITY_PORT],
    ["discord-bridge", undefined],
  ] as const) {
    const dir = join(root, "apps", name, "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.js"),
      listenPort
        ? `require('node:http').createServer((req,res)=>res.end('{}')).listen(${listenPort},'127.0.0.1');`
        : "setInterval(()=>{},1000);",
    );
  }
  const tunnelFile = join(root, "cloudflared");
  writeFileSync(tunnelFile, "setInterval(()=>{},1000);\n");
  const tunnel = spawn(process.execPath, [tunnelFile, "tunnel", "run", "fixture-tunnel"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => tunnel.once("spawn", resolve));
  const options = {
    repoRoot: root,
    env,
    stderr: { write() {} },
    listProcessCommandsImpl: () => listProcessCommands().filter(([, command]) => command.includes(root)),
  };
  const cli = async (_runtime: string, args: readonly string[]) => {
    if (args[0] === "update")
      return {
        runtime: {
          root,
          commit: "b".repeat(40),
          instanceId: "22222222-2222-2222-2222-222222222222",
          pid: process.pid,
        },
      };
    let output = "";
    const commandOptions = {
      ...options,
      stdout: {
        write(chunk: string) {
          output += chunk;
        },
      },
    };
    if (args[0] === "down") await runDownCommand(args.slice(1), commandOptions);
    else await runRestartCommand(args.slice(1), commandOptions);
    return JSON.parse(output);
  };
  try {
    expect((await inspectService(managedService("tunnel"), options)).owned).toBe(false);
    expect(await stopTarget("tunnel", options)).toMatchObject([
      { id: "tunnel", ok: false, error: expect.stringContaining("was not started by the clankie launcher") },
    ]);
    expect((await runtimeUpdateServices(root, "down", cli, env)).ok).toBe(true);
    const result = await runtimeUpdateServices(root, "restart", cli, env);
    expect(result.ok).toBe(true);
    expect(result.services.map((entry) => entry.id)).not.toContain("tunnel");
    expect((await runtimeUpdateServices(root, "down", cli, env)).ok).toBe(true);
    env.CLANKIE_SERVICES = "clankie,relay";
    const limited = await runtimeUpdateServices(root, "restart", cli, env);
    expect(limited.ok).toBe(true);
    expect(limited.services.map((entry) => entry.id)).toEqual(["clankie", "relay"]);
    expect((await runtimeUpdateServices(root, "down", cli, env)).ok).toBe(true);
    expect(tunnel.exitCode).toBeNull();
    process.kill(tunnel.pid!, 0);
  } finally {
    await stopTarget("activity", options);
    await stopTarget("relay", options);
    await stopTarget("discord-bridge", options);
    await stopTarget("clankie", options);
    tunnel.kill("SIGTERM");
    await new Promise<void>((resolve) => tunnel.once("exit", () => resolve()));
  }
}, 30_000);

it("an uncertain ending retires itself once its helper finished and this service runs the clean pin", async () => {
  const f = fixture();
  const accepted = await f.updater.request("main", authority);
  const updates = join(f.home, ".clankie/updates");
  const directory = join(updates, accepted.pending!);
  const ended = {
    ...accepted.latest!,
    phase: "stop-unconfirmed" as const,
    reason: "new-services-stop-unconfirmed",
    updatedAt: new Date().toISOString(),
  };
  writeRuntimeUpdate(directory, ended);
  // The service that boots next proves the outcome; the helper is a fake here.
  const booted = createRuntimeUpdater({
    repoRoot: f.runtime,
    env: { HOME: f.home },
    spawnHelper: () => Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess,
  });
  // No final result line yet: the helper may still be running.
  expect(booted.reconcile!()).toBeUndefined();
  expect(booted.status()).toMatchObject({ pending: accepted.pending, needsReconciliation: true });
  expect((await booted.request("main", authority)).accepted).toBe(false);
  appendFileSync(join(directory, "helper.log"), `${JSON.stringify(ended)}\n`);
  // An edited pin is the owner's to resolve.
  writeFileSync(join(f.runtime, "content"), "edited in place");
  expect(booted.reconcile!()).toBeUndefined();
  f.git(f.runtime, "checkout", "--", "content");
  const reconciled = booted.reconcile!();
  expect(reconciled?.reconciled).toMatchObject({ commit: f.old, instanceId: booted.runtime.instanceId });
  expect(booted.status().pending).toBeUndefined();
  expect(booted.status().needsReconciliation).toBeUndefined();
  expect(booted.status().latest?.reconciled?.commit).toBe(f.old);
  expect(readdirSync(updates).some((name) => name.startsWith(`active.reconciled-${accepted.pending}`))).toBe(
    true,
  );
  expect((await booted.request("main", authority)).accepted).toBe(true);
});
it("owner start, stop and restart wait while an update helper runs; the helper's own calls pass", async () => {
  const f = fixture();
  const accepted = await f.updater.request("main", authority);
  const directory = join(f.home, ".clankie/updates", accepted.pending!);
  writeRuntimeUpdate(directory, {
    ...accepted.latest!,
    phase: "restarting",
    updatedAt: new Date().toISOString(),
  });
  const env = { HOME: f.home };
  // A real process whose command names this operation's helper, as `ps` sees it.
  const helper = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)", join(directory, "runtime-update-helper.mjs")],
    {
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolve) => helper.once("spawn", resolve));
  try {
    const options = { repoRoot: f.runtime, env, stderr: { write() {} }, stdout: { write() {} } };
    for (const run of [runRestartCommand, runStartCommand, runDownCommand])
      await expect(run([], options)).rejects.toThrow("An update is restarting");
    expect(updateHoldingServices(env)).toEqual({ id: accepted.pending, phase: "restarting" });
    expect(updateHoldingServices({ ...env, CLANKIE_UPDATE_OPERATION: accepted.pending })).toBeUndefined();
    // A helper copied by an older runtime is recognized as the caller's parent.
    expect(updateHoldingServices(env, undefined, helper.pid)).toBeUndefined();
  } finally {
    helper.kill();
    await new Promise((resolve) => helper.once("exit", resolve));
  }
  // A helper that is gone holds nothing; restart stays the owner's remedy.
  expect(updateHoldingServices(env)).toBeUndefined();
});
it.each([false, true])(
  "main update safely syncs the owner checkout and journals blocked edits (dirty=%s)",
  async (dirty) => {
    const f = fixture();
    if (dirty) writeFileSync(join(f.source, "content"), "owner draft");
    const accepted = await f.updater.request("main", authority);
    expect(accepted.latest?.ownerCheckoutSync).toMatchObject({
      path: f.source,
      outcome: dirty ? "blocked" : "updated",
      ...(dirty
        ? { blockers: [{ path: "content", ageSeconds: expect.any(Number) }] }
        : { before: f.old, after: f.latest }),
    });
    expect(f.updater.status().latest?.ownerCheckoutSync).toEqual(accepted.latest?.ownerCheckoutSync);
    expect(f.git(f.source, "rev-parse", "HEAD")).toBe(dirty ? f.old : f.latest);
    expect(readFileSync(join(f.source, "content"), "utf8")).toBe(dirty ? "owner draft" : "remote repair");
    expect(f.git(f.runtime, "rev-parse", "HEAD")).toBe(f.old);
  },
);

