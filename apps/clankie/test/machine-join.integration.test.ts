import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
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
import { runJoinCommand } from "../../tui/src/command/join.ts";
import {
  exchangeJoinedMachine,
  readJoinedMachineCredential,
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
    ).toMatchObject({ ok: false, error: "operation_unavailable" });
    expect(await f.machines.setAccess(credential.lease.machineId, { accessLevel: "shell" })).toMatchObject({
      accessEnforcement: "joined-host",
    });
    expect(
      await f.joins.request(credential.lease.machineId, {
        kind: "shell",
        directory: f.directory,
        command: "printf joined-fixture",
      }),
    ).toMatchObject({ ok: true, output: "joined-fixture" });
    const large = await f.joins.request(credential.lease.machineId, {
      kind: "shell",
      directory: f.directory,
      command: "printf 'bounded-prefix'; printf '%20000s' x",
    });
    expect(large).toMatchObject({ ok: true, truncated: true });
    expect(large.output).toMatch(/^bounded-prefix/u);
    await f.machines.remove(credential.lease.machineId);
    expect(await running).toBe(0);
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
