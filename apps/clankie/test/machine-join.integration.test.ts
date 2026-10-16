import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { MachineJoinLeaseSchema, MachineJoinStatusSchema } from "@clankie/protocol/machine-join";
import { machineJoinHash, machineJoinKey } from "../src/machine-join-crypto.ts";
import { openGatewayValue, sealGatewayValue } from "../src/gateway-encryption.ts";
import { machineJoinLeaseAad, machineJoinExchangeAad } from "@clankie/protocol/machine-join";
import { MachineJoins } from "../src/machine-joins.ts";
import { createMachineJoinRoutes } from "../src/machine-join-routes.ts";
import { machineAccessLevel, requireMachineAccess } from "../src/machine-access.ts";
import { Machines } from "../src/machines.ts";
import { joinedMachineShellTool, offersJoinedMachineShell } from "../src/captain/machine-coding-tools.ts";
import { runJoinCommand } from "../../tui/src/command/join.ts";
import {
  exchangeJoinedMachine,
  readJoinedMachineCredential,
  createJoinedMachineShell,
  runJoinedMachineChannel,
  saveJoinedMachineCredential,
} from "../../tui/bin/joined-machine-client.ts";

const fixtureHost = "fixture_join_host_0001";
const owner = "synthetic-owner-join-test";
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error("Fixture condition did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-join-")));
  const directory = join(root, "workspace");
  await mkdir(directory);
  const settings = new SettingsStore(join(root, "settings.json"));
  const ledger = join(root, "joins");
  const machines = new Machines({
    settings,
    primary: () => undefined,
    changed: () => {},
    sshConfig: async () => "",
    run: async () => ({ stdout: '{"sessions":[]}' }),
  });
  const secrets = new FileCredentialStore(join(root, "host-secrets.json"));
  const joins = new MachineJoins({
    settings,
    secrets,
    directory: ledger,
    changed: () => machines.invalidate(),
  });
  machines.setJoinedProvider(joins);
  const store = new FileCredentialStore(join(root, "credentials.json"));
  // Test-only loopback relay. Production gateway ingress belongs to clankie-ops.
  const relay = new Hono().route(
    `/h/${fixtureHost}`,
    createMachineJoinRoutes(joins, async (request) =>
      request.headers.get("authorization") === `Bearer ${owner}` ? true : "authentication_required",
    ),
  );
  const server = serve({ fetch: relay.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const gateway = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `${gateway}/h/${fixtureHost}`;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const approve = async (accessLevel = "workers", directories = [directory], platform = "darwin") => {
    const claimSecret = randomBytes(32).toString("base64url");
    const code = randomBytes(32).toString("base64url");
    const ticket = await (
      await post("/v1/machine-joins/start", {
        name: "fixture machine",
        platform,
        directories,
        claimSecret,
        approvalHash: machineJoinHash(code),
      })
    ).json();
    expect((await post("/v1/machine-joins/approve", { code, accessLevel, directories }, owner)).status).toBe(
      200,
    );
    const status = MachineJoinStatusSchema.parse(
      await (await post("/v1/machine-joins/status", { joinId: ticket.joinId }, claimSecret)).json(),
    );
    if (status.state !== "approved") throw Error("Fixture approval failed");
    return {
      origin,
      lease: MachineJoinLeaseSchema.parse(
        JSON.parse(
          openGatewayValue(machineJoinKey(code), status.sealedLease, machineJoinLeaseAad(ticket.joinId)),
        ),
      ),
      localDirectories: directories,
    };
  };
  return {
    root,
    directory,
    ledger,
    settings,
    secrets,
    machines,
    joins,
    store,
    gateway,
    origin,
    post,
    approve,
    async close() {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("public CLI waits for owner consent, joins through the relay, and removal revokes the persisted capability", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let stdout = "",
    stderr = "";
  const running = runJoinCommand(
    ["--gateway", f.gateway, "--host", fixtureHost, "--directory", f.directory],
    {
      joinCredentialStore: f.store,
      signal: abort.signal,
      intervalMs: 10,
      stdout: {
        write: (value) => {
          stdout += value;
        },
      },
      stderr: {
        write: (value) => {
          stderr += value;
        },
      },
    },
  );
  try {
    expect(
      await runHeadlessCaptainCommand(["join", "--help"], {
        repoRoot: f.root,
        env: {},
        stdout: { write: () => {} },
      }),
    ).toBe(0);
    await until(() => /Approve ([A-Za-z0-9_-]{43})/u.test(stdout));
    expect(await f.joins.inventory()).toEqual([]);
    expect(await readJoinedMachineCredential(f.store)).toBeUndefined();
    const code = /Approve ([A-Za-z0-9_-]{43})/u.exec(stdout)![1]!;
    expect(
      (
        await f.post("/v1/machine-joins/approve", {
          code,
          accessLevel: "workers",
          directories: [f.directory],
        })
      ).status,
    ).toBe(401);
    expect(
      await runJoinCommand(["approve", code, "--access", "shell", "--directory", f.directory], {
        host: f.origin,
        env: { CLANKIE_OPERATOR_TOKEN: owner },
        operatorCredentialStore: new FileCredentialStore(join(f.root, "owner.json")),
        stdout: {
          write: (value) => {
            stdout += value;
          },
        },
        stderr: {
          write: (value) => {
            stderr += value;
          },
        },
      }),
    ).toBe(0);
    await until(async () => (await f.joins.inventory())[0]?.state === "available");
    const initial = (await readJoinedMachineCredential(f.store))!;
    await f.machines.setAccess(initial.lease.machineId, { accessLevel: "workers" });
    const credential = (await readJoinedMachineCredential(f.store))!;
    expect((await f.machines.list()).machines).toContainEqual(
      expect.objectContaining({
        id: credential.lease.machineId,
        transport: "join",
        accessLevel: "workers",
        accessEnforcement: "joined-host",
      }),
    );
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "shell",
        directory: f.directory,
        command: "printf should-not-run",
      }),
    ).toMatchObject({ ok: false, error: "machine_access_refused" });
    expect(
      await f.joins.request(credential.lease.machineId, { kind: "screen", request: "capture" }),
    ).toMatchObject({ ok: false, error: "machine_access_refused" });
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "workers",
        directory: f.directory,
        request: "hire",
      }),
    ).toMatchObject({ ok: false, error: "operation_failed" });
    expect(await f.machines.setAccess(credential.lease.machineId, { accessLevel: "shell" })).toMatchObject({
      accessEnforcement: "joined-host",
    });
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "shell",
        directory: f.directory,
        command: "printf joined-fixture",
      }),
    ).toMatchObject({ ok: true, output: "[exit 0]\njoined-fixture" });
    const large = await f.joins.request(credential.lease.machineId, {
      kind: "shell",
      directory: f.directory,
      command: "printf 'bounded-prefix'; printf '%20000s' x",
    });
    expect(large).toMatchObject({ ok: true, truncated: true });
    expect(large.output).toMatch(/^\[exit 0\]\nbounded-prefix/u);
    await f.machines.remove(credential.lease.machineId);
    expect(await running).toBe(0);
    expect(await f.store.get("clankie-joined-machine")).toBeUndefined();
    await expect(
      readJoinedMachineCredential(new FileCredentialStore(join(f.root, "credentials.json"))),
    ).rejects.toThrow("revoked");
    expect(
      await runJoinCommand(["leave"], { joinCredentialStore: f.store, stdout: { write: () => {} } }),
    ).toBe(0);
    expect(await readJoinedMachineCredential(f.store)).toBeUndefined();
    expect(
      (await f.post("/v1/joined-machines/challenge", { machineId: credential.lease.machineId })).status,
    ).toBe(403);
    const restored = new MachineJoins({ settings: f.settings, secrets: f.secrets, directory: f.ledger });
    await expect(restored.poll(credential.lease.token, { results: [] })).rejects.toThrow("revoked");
    expect(stdout + stderr).not.toContain(credential.lease.token);
    expect(await readFile(join(f.ledger, "machines.json"), "utf8")).not.toContain(credential.lease.token);
  } finally {
    abort.abort();
    await running;
    await f.close();
  }
});

test("claim ownership, independent canonical registry and directory intersection prevent grant spoofing", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let running: Promise<unknown> | undefined;
  try {
    const claimSecret = randomBytes(32).toString("base64url");
    const code = "-" + randomBytes(32).toString("base64url").slice(1);
    const ticket = await (
      await f.post("/v1/machine-joins/start", {
        name: "fixture pc metadata",
        platform: "win32",
        directories: [f.root],
        claimSecret,
        approvalHash: machineJoinHash(code),
      })
    ).json();
    expect(
      await runJoinCommand(["approve", code, "--access", "shell", "--directory", f.root], {
        host: f.origin,
        env: { CLANKIE_OPERATOR_TOKEN: owner },
        operatorCredentialStore: new FileCredentialStore(join(f.root, "owner.json")),
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      }),
    ).toBe(0);
    expect(
      await (
        await f.post(
          "/v1/machine-joins/status",
          { joinId: ticket.joinId },
          randomBytes(32).toString("base64url"),
        )
      ).json(),
    ).toEqual({ state: "expired" });
    const approved = MachineJoinStatusSchema.parse(
      await (await f.post("/v1/machine-joins/status", { joinId: ticket.joinId }, claimSecret)).json(),
    );
    if (approved.state !== "approved") throw Error("Fixture approval failed");
    const credential = {
      origin: f.origin,
      lease: MachineJoinLeaseSchema.parse(
        JSON.parse(
          openGatewayValue(machineJoinKey(code), approved.sealedLease, machineJoinLeaseAad(ticket.joinId)),
        ),
      ),
      localDirectories: [f.directory],
    };
    await saveJoinedMachineCredential(f.store, credential);
    let connected = false;
    running = runJoinedMachineChannel(credential, {
      store: f.store,
      signal: abort.signal,
      intervalMs: 10,
      onConnected: () => {
        connected = true;
      },
    });
    await until(() => connected);
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(f.directory, "escape"));
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "shell",
        directory: join(f.directory, "escape"),
        command: "printf escaped",
      }),
    ).toMatchObject({ error: "directory_refused" });
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "shell",
        directory: outside,
        command: "printf escaped",
      }),
    ).toMatchObject({ error: "directory_refused" });
    await f.settings.update((current) => ({
      ...current,
      machineAccess: { ...current.machineAccess, invented: "screen" },
    }));
    expect(machineAccessLevel(await f.settings.load(), "invented", f.joins)).toBe("portal");
    await expect(f.machines.setAccess("invented", { accessLevel: "screen" })).rejects.toThrow(
      "Unknown machine",
    );
    await expect(
      requireMachineAccess(f.settings, credential.lease.machineId, "shell", f.joins),
    ).resolves.toBeUndefined();
    await f.machines.setAccess(credential.lease.machineId, { accessLevel: "portal" });
    await expect(
      requireMachineAccess(f.settings, credential.lease.machineId, "shell", f.joins),
    ).rejects.toThrow("this request requires shell");
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "shell",
        directory: f.directory,
        command: "printf denied",
      }),
    ).toMatchObject({ error: "machine_access_refused" });
    expect(
      (
        await f.post("/v1/machine-joins/start", {
          name: "claim-local",
          platform: "darwin",
          directories: [],
          claimSecret,
          approvalHash: machineJoinHash(code),
          machineId: "local",
        })
      ).status,
    ).toBe(400);
  } finally {
    abort.abort();
    await running;
    await f.close();
  }
});

test("leave requires new owner approval and lost delivery never replays an operation", async () => {
  const f = await fixture();
  try {
    const credential = await f.approve("shell");
    const task = f.joins.request(
      credential.lease.machineId,
      { kind: "shell", directory: f.directory, command: "printf one-shot" },
      100,
    );
    const batch = (await exchangeJoinedMachine(credential, { op: "poll", results: [] })) as {
      requests: unknown[];
    };
    expect(batch.requests).toHaveLength(1);
    expect(await exchangeJoinedMachine(credential, { op: "poll", results: [] })).toMatchObject({
      requests: [],
    });
    expect(await task).toMatchObject({ ok: false });
    await saveJoinedMachineCredential(f.store, credential);
    expect(
      await runJoinCommand(["leave"], { joinCredentialStore: f.store, stdout: { write: () => {} } }),
    ).toBe(0);
    expect(f.joins.has(credential.lease.machineId)).toBe(false);
    expect(await readJoinedMachineCredential(f.store)).toBeUndefined();
    expect(
      (await f.post("/v1/joined-machines/challenge", { machineId: credential.lease.machineId })).status,
    ).toBe(403);
    const replacement = await f.approve();
    await expect(f.machines.setAccess(replacement.lease.machineId, { accessLevel: "shell" })).rejects.toThrow(
      "Rejoin with owner approval",
    );
    await f.settings.update((current) => ({
      ...current,
      machineAccess: { ...current.machineAccess, [replacement.lease.machineId]: "screen" },
    }));
    expect(machineAccessLevel(await f.settings.load(), replacement.lease.machineId, f.joins)).toBe("workers");
    expect(replacement.lease.machineId).not.toBe(credential.lease.machineId);
  } finally {
    await f.close();
  }
});

test("an untrusted relay cannot read, forge, reflect or replay an authenticated machine exchange", async () => {
  const f = await fixture();
  try {
    const credential = await f.approve("shell");
    const work = f.joins.request(
      credential.lease.machineId,
      { kind: "shell", directory: f.directory, command: "printf private-command" },
      150,
    );
    let envelope: Record<string, unknown> | undefined;
    let wireResponse = "";
    const relay: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith("/channel")) {
        envelope = JSON.parse(String(init?.body));
        expect(init?.headers).not.toHaveProperty("authorization");
        wireResponse = await response.text();
        return new Response(wireResponse, {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    expect(await exchangeJoinedMachine(credential, { op: "poll", results: [] }, relay)).toMatchObject({
      requests: [{ operation: { command: "printf private-command" } }],
    });
    expect(JSON.stringify(envelope) + wireResponse).not.toContain(credential.lease.token);
    expect(JSON.stringify(envelope) + wireResponse).not.toContain("private-command");
    expect((await f.post("/v1/joined-machines/channel", envelope)).status).toBe(403);
    expect(await exchangeJoinedMachine(credential, { op: "poll", results: [] })).toMatchObject({
      requests: [],
    });
    expect(await work).toMatchObject({ ok: false });
    const challenge = f.joins.challenge(credential.lease.machineId).challenge;
    expect((await f.post("/v1/joined-machines/channel", { ...envelope, challenge })).status).toBe(403);
    expect(
      (
        await f.post("/v1/joined-machines/channel", {
          ...envelope,
          sealedRequest: JSON.parse(wireResponse).sealedResponse,
        })
      ).status,
    ).toBe(403);
    const forgingRelay: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!String(url).endsWith("/channel")) return response;
      // A plausible plaintext operation cannot replace a body-authenticated batch.
      return Response.json({ sealedResponse: JSON.stringify({ policy: credential.lease, requests: [] }) });
    };
    await expect(
      exchangeJoinedMachine(credential, { op: "poll", results: [] }, forgingRelay),
    ).rejects.toThrow();
    expect(f.joins.has(credential.lease.machineId)).toBe(true);
  } finally {
    await f.close();
  }
});

test("the receiver preserves original host consent even if authenticated body policy widens it", async () => {
  const f = await fixture(),
    abort = new AbortController();
  let running: Promise<unknown> | undefined;
  try {
    const approved = await f.approve("workers");
    const credential = { ...approved, localDirectories: [f.root] };
    await saveJoinedMachineCredential(f.store, credential);
    // Exercise real envelopes and API traffic with a synthetic consenting body
    // attempting to widen its assertions after the original host approval.
    const wideningBody: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!String(url).endsWith("/channel") || !response.ok) return response;
      const envelope = JSON.parse(String(init?.body));
      const aad = (direction: "request" | "response") =>
        machineJoinExchangeAad(direction, envelope.machineId, envelope.requestId, envelope.challenge);
      const payload = JSON.parse(
        openGatewayValue(machineJoinKey(credential.lease.token), envelope.sealedRequest, aad("request")),
      );
      const batch = JSON.parse(
        openGatewayValue(
          machineJoinKey(payload.responseSecret),
          (await response.json()).sealedResponse,
          aad("response"),
        ),
      );
      batch.policy.accessLevel = "screen";
      batch.policy.directories = [f.root];
      return Response.json({
        sealedResponse: sealGatewayValue(
          machineJoinKey(payload.responseSecret),
          JSON.stringify(batch),
          aad("response"),
        ),
      });
    };
    running = runJoinedMachineChannel(credential, {
      store: f.store,
      signal: abort.signal,
      intervalMs: 10,
      fetchImpl: wideningBody,
    });
    await until(async () => (await f.joins.inventory())[0]?.state === "available");
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "shell",
        directory: f.directory,
        command: "printf must-not-run",
      }),
    ).toMatchObject({ error: "machine_access_refused" });
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "workers",
        directory: f.root,
        request: "must-not-hire",
      }),
    ).toMatchObject({ error: "directory_refused" });
  } finally {
    abort.abort();
    await running;
    await f.close();
  }
});

test("a joined machine reconnects after its home restarts, and revocation still ends it", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let running: Promise<unknown> | undefined;
  let home: ReturnType<typeof serve> | undefined;
  const listen = async (joins: MachineJoins, port = 0) => {
    const routes = new Hono().route(
      `/h/${fixtureHost}`,
      createMachineJoinRoutes(joins, async () => "authentication_required"),
    );
    home = serve({ fetch: routes.fetch, hostname: "127.0.0.1", port });
    if (!home.listening) await new Promise<void>((resolve) => home!.once("listening", resolve));
    return (home.address() as AddressInfo).port;
  };
  const stop = async () => {
    if ("closeAllConnections" in home!) home.closeAllConnections();
    await new Promise<void>((resolve) => home!.close(() => resolve()));
  };
  try {
    const approved = await f.approve("shell");
    const port = await listen(f.joins);
    const credential = { ...approved, origin: `http://127.0.0.1:${port}/h/${fixtureHost}` };
    await saveJoinedMachineCredential(f.store, credential);
    const seen = { connected: 0, disconnected: 0, reconnected: 0 };
    running = runJoinedMachineChannel(credential, {
      store: f.store,
      signal: abort.signal,
      intervalMs: 10,
      retryMs: 10,
      onConnected: () => seen.connected++,
      onDisconnected: () => seen.disconnected++,
      onReconnected: () => seen.reconnected++,
    });
    await until(() => seen.connected === 1);
    await stop();
    await until(() => seen.disconnected === 1);
    // A new home process restores the same machine from its durable ledger.
    const restored = new MachineJoins({ settings: f.settings, secrets: f.secrets, directory: f.ledger });
    await listen(restored, port);
    await until(() => seen.reconnected === 1);
    expect(
      await restored.request(credential.lease.machineId, {
        kind: "shell",
        directory: f.directory,
        command: "printf after-restart",
      }),
    ).toMatchObject({ ok: true, output: "[exit 0]\nafter-restart" });
    expect(seen).toEqual({ connected: 1, disconnected: 1, reconnected: 1 });
    await restored.remove(credential.lease.machineId);
    expect(await running).toBe("revoked");
    await expect(readJoinedMachineCredential(f.store)).rejects.toThrow("revoked");
  } finally {
    abort.abort();
    await running;
    if (home?.listening) await stop();
    await f.close();
  }
});

// Clankie's own shell on a joined machine (VUH-2319): every guarantee through the real receiver and a real shell.
async function joinedShell(
  level = "shell",
  options: { shellTimeoutMs?: number; fetchImpl?: typeof fetch; requestTimeoutMs?: number } = {},
) {
  const f = await fixture();
  const abort = new AbortController();
  const credential = await f.approve(level);
  const machineId = credential.lease.machineId;
  await saveJoinedMachineCredential(f.store, credential);
  const channel = runJoinedMachineChannel(credential, {
    store: f.store,
    signal: abort.signal,
    intervalMs: 10,
    retryMs: 10,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.shellTimeoutMs ? { ports: { shell: createJoinedMachineShell(options.shellTimeoutMs) } } : {}),
  });
  await until(async () => (await f.joins.inventory())[0]?.state === "available");
  const turn: { autonomous?: boolean } = {};
  const tool = joinedMachineShellTool(f.joins, f.settings, {
    lane: "operator",
    conversationId: "owner-chat",
    turn,
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  const run = (directory: string, command: string) =>
    tool.execute("call", { machineId, directory, command }, undefined, undefined, undefined as never);
  return {
    f,
    machineId,
    channel,
    run,
    turn,
    audit: async () => (await f.joins.shellAudit()).entries,
    async close() {
      abort.abort();
      await channel;
      await f.close();
    },
  };
}

test("joined shell rechecks the live level on every call and audits who, where, the digest and the exit", async () => {
  const s = await joinedShell();
  try {
    const command = "pwd; printf oops >&2; exit 3";
    const ran = await s.run(s.f.directory, command);
    expect(ran.content[0]).toEqual({ type: "text", text: `[exit 3]\n${s.f.directory}\n[stderr]\noops` });
    await s.f.machines.setAccess(s.machineId, { accessLevel: "workers" });
    await expect(s.run(s.f.directory, "printf lowered")).rejects.toThrow(
      `Machine ${s.machineId} has workers access; this request requires shell.`,
    );
    await s.f.machines.setAccess(s.machineId, { accessLevel: "shell" });
    expect((await s.run(s.f.directory, "printf restored")).content[0]).toMatchObject({
      text: "[exit 0]\nrestored",
    });
    const [first, refused, restored] = await s.audit();
    expect(first).toMatchObject({
      lane: "operator",
      origin: "owner",
      conversationId: "owner-chat",
      machineId: s.machineId,
      directory: s.f.directory,
      commandSha256: createHash("sha256").update(command).digest("hex"),
      outcome: "completed",
      exitCode: 3,
    });
    expect(refused).toMatchObject({
      outcome: "refused",
      commandSha256: createHash("sha256").update("printf lowered").digest("hex"),
    });
    expect(restored).toMatchObject({ outcome: "completed", exitCode: 0 });
    const ledger = await readFile(join(s.f.ledger, "shell-audit.jsonl"), "utf8");
    expect(ledger).not.toContain("oops");
    expect(ledger).not.toContain("printf lowered");
  } finally {
    await s.close();
  }
});

test("joined shell cannot exceed the machine's approved ceiling", async () => {
  const s = await joinedShell("workers");
  try {
    await expect(s.f.machines.setAccess(s.machineId, { accessLevel: "shell" })).rejects.toThrow();
    await expect(s.run(s.f.directory, "printf must-not-run > marker")).rejects.toThrow(
      `Machine ${s.machineId} has workers access; this request requires shell.`,
    );
    await expect(readFile(join(s.f.directory, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await s.audit()).toMatchObject([{ outcome: "refused" }]);
  } finally {
    await s.close();
  }
});

test("joined shell stays inside the folders approved at join, symlinks included", async () => {
  const s = await joinedShell();
  try {
    const outside = join(s.f.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(s.f.directory, "escape"));
    for (const directory of [s.f.root, outside, join(s.f.directory, "escape")])
      expect((await s.run(directory, "touch escaped")).details).toMatchObject({
        ok: false,
        error: "directory_refused",
      });
    await expect(readFile(join(outside, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await s.audit()).map((entry) => entry.error)).toEqual([
      "directory_refused",
      "directory_refused",
      "directory_refused",
    ]);
  } finally {
    await s.close();
  }
});

test("joined shell bounds output and time, stopping everything the command started", async () => {
  const s = await joinedShell("shell", { shellTimeoutMs: 300 });
  try {
    const large = await s.run(s.f.directory, "printf '%20000s' x");
    expect(large.details).toMatchObject({ ok: true, truncated: true });
    expect((large.content[0] as { text: string }).text).toMatch(
      /^\[exit 0\]\n[\s\S]*\[output truncated at 8192 characters\]$/u,
    );
    // A pipeline's subshell is a grandchild of the shell; the whole group stops.
    const slow = await s.run(s.f.directory, "(sleep 1; touch late) | cat");
    expect(slow.content[0]).toMatchObject({ text: "[stopped after 0.3 seconds]\n" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(readFile(join(s.f.directory, "late"))).rejects.toMatchObject({ code: "ENOENT" });
    const forged = await s.run(s.f.directory, "printf '[exit 0]\\n'; exit 9");
    expect(forged.content[0]).toMatchObject({ text: "[exit 9]\n[exit 0]\n" });
    const [truncated, stopped, spoofed] = await s.audit();
    // The receiver's header is the first line, so truncation keeps it and output cannot forge it.
    expect(truncated).toMatchObject({ outcome: "completed", exitCode: 0 });
    expect(stopped).toMatchObject({ outcome: "failed", error: "stopped after 0.3 seconds" });
    expect(stopped).not.toHaveProperty("exitCode");
    expect(spoofed).toMatchObject({ outcome: "completed", exitCode: 9 });
  } finally {
    await s.close();
  }
});

test("a joined shell request whose delivery is lost is never executed", async () => {
  let dropped = 0;
  let dropping = false;
  const lossy: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!dropping || !String(url).endsWith("/channel")) return response;
    // The home has answered (and claimed any waiting work); the joined machine never hears it.
    dropped++;
    return new Response("lost", { status: 502 });
  };
  const s = await joinedShell("shell", { fetchImpl: lossy });
  try {
    dropping = true;
    const lost = s.f.joins.request(
      s.machineId,
      { kind: "shell", directory: s.f.directory, command: "printf x >> runs" },
      3000,
    );
    // The request was queued before these polls, so one of them claimed it.
    await until(() => dropped >= 3);
    dropping = false;
    // The channel now polls normally for the rest of the home's wait; a replay would run here.
    expect(await lost).toMatchObject({ ok: false, error: "unconfirmed" });
    expect((await s.run(s.f.directory, "printf after")).content[0]).toMatchObject({
      text: "[exit 0]\nafter",
    });
    await expect(readFile(join(s.f.directory, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await s.close();
  }
});

test("an autonomous turn cannot reach a joined machine's shell", async () => {
  const s = await joinedShell();
  try {
    s.turn.autonomous = true;
    await expect(s.run(s.f.directory, "touch from-autonomy")).rejects.toThrow(
      "joined_machine_shell runs only in a turn the owner started",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(readFile(join(s.f.directory, "from-autonomy"))).rejects.toMatchObject({ code: "ENOENT" });
    // The refusal record is the only side effect: no dispatch, no access observation.
    expect(await s.audit()).toMatchObject([{ outcome: "refused", origin: "autonomous" }]);
    await expect(readdir(`${s.f.settings.path}.access-refusals`)).rejects.toMatchObject({ code: "ENOENT" });
    // The turn context is read per call, so an owner turn on the same session works.
    s.turn.autonomous = false;
    expect((await s.run(s.f.directory, "printf owner")).content[0]).toMatchObject({
      text: "[exit 0]\nowner",
    });
  } finally {
    await s.close();
  }
});

test("a joined shell call whose result never arrives is audited as unknown", async () => {
  let dropping = false;
  const lossy: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    return dropping && String(url).endsWith("/channel") ? new Response("lost", { status: 502 }) : response;
  };
  const s = await joinedShell("shell", { fetchImpl: lossy, requestTimeoutMs: 500 });
  try {
    dropping = true;
    expect((await s.run(s.f.directory, "printf x >> runs")).details).toMatchObject({
      ok: false,
      error: "unconfirmed",
    });
    dropping = false;
    expect(await s.audit()).toMatchObject([{ outcome: "unknown", error: "unconfirmed" }]);
  } finally {
    await s.close();
  }
});

test("revoking a joined machine mid-call stops everything the command started", async () => {
  const s = await joinedShell();
  try {
    const call = s.run(s.f.directory, "(sleep 1; touch finished) | cat");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await s.f.machines.remove(s.machineId);
    expect((await call).details).toMatchObject({ ok: false, error: "revoked" });
    expect(await s.channel).toBe("revoked");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(readFile(join(s.f.directory, "finished"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(s.run(s.f.directory, "printf after")).rejects.toThrow(`No joined machine ${s.machineId}.`);
    expect((await s.audit()).map((entry) => entry.outcome)).toEqual(["failed", "refused"]);
  } finally {
    await s.close();
  }
});

test("lowering a joined machine below shell mid-call stops the running command", async () => {
  const s = await joinedShell();
  try {
    const call = s.run(s.f.directory, "(sleep 1; touch finished) | cat");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await s.f.machines.setAccess(s.machineId, { accessLevel: "workers" });
    expect((await call).details).toMatchObject({ ok: false, error: "revoked" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(readFile(join(s.f.directory, "finished"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await s.close();
  }
});

test("a joined shell call that cannot be audited never leaves this machine", async () => {
  const s = await joinedShell();
  try {
    await symlink(join(s.f.root, "elsewhere.jsonl"), join(s.f.ledger, "shell-audit.jsonl"));
    await expect(s.run(s.f.directory, "touch unaudited")).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(readFile(join(s.f.directory, "unaudited"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await s.close();
  }
});

test("joined shell is offered only in the owner console lane, never Discord", () => {
  const ownerRoom = { privateContext: true, actorId: owner, authorize: async () => true };
  expect(offersJoinedMachineShell({ lane: "operator", systemTools: true, discordAccess: undefined })).toBe(
    true,
  );
  expect(offersJoinedMachineShell({ lane: "operator", systemTools: false, discordAccess: undefined })).toBe(
    false,
  );
  for (const lane of ["discord_presence", "discord_voice", "gameplay"])
    for (const discordAccess of [undefined, ownerRoom])
      expect(offersJoinedMachineShell({ lane, systemTools: true, discordAccess })).toBe(false);
  expect(offersJoinedMachineShell({ lane: "operator", systemTools: true, discordAccess: ownerRoom })).toBe(
    false,
  );
});
