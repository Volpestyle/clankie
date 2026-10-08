import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { ComputerLeaseSchema } from "@clankie/interactive-environment";
import {
  MachineJoinLeaseSchema,
  MachineJoinStatusSchema,
  MachineJoinEventSchema,
} from "@clankie/protocol/machine-join";
import { machineJoinLeaseAad } from "@clankie/protocol/machine-join";
import { machineJoinHash, machineJoinKey } from "../src/machine-join-crypto.ts";
import { openGatewayValue } from "../src/gateway-encryption.ts";
import { MachineJoins } from "../src/machine-joins.ts";
import { createMachineJoinRoutes } from "../src/machine-join-routes.ts";
import { Machines } from "../src/machines.ts";
import { JoinedComputer } from "../src/joined-computer.ts";
import { registerComputerRoutes } from "../src/computer-http.ts";
import { runJoinedMachineChannel, saveJoinedMachineCredential } from "../../tui/bin/joined-machine-client.ts";
import { runJoinCommand } from "../../tui/src/command/join.ts";
import { runComputerCommand } from "../../tui/src/command/computer.ts";
import { createJoinedScreenPorts } from "../../tui/bin/joined-screen-host.ts";
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
  registerComputerRoutes(relay, {
    joined: new JoinedComputer(joins, settings),
    identity: async (request, conversationId) =>
      request.headers.get("authorization") === `Bearer ${owner}`
        ? {
            conversationId,
            route: { owner: { conversationId }, mode: "machine" },
            current: () => true,
            authorize: async () => true,
          }
        : undefined,
  });
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

async function screenFixture(choice: string, proof = "certain", json = false, malformedReceipt = false) {
  const f = await fixture(),
    abort = new AbortController();
  const credential = await f.approve("screen");
  const journal = join(f.root, "native-actions.jsonl");
  await writeFile(journal, "");
  const ports = createJoinedScreenPorts({
    machineId: credential.lease.machineId,
    directory: join(f.root, "body"),
    executable: process.execPath,
    args: [join(import.meta.dirname, "fixtures/lent-screen-provider.mjs"), choice, journal, proof],
  });
  if (malformedReceipt) {
    const nativeScreen = ports.screen!;
    // Adversarial authenticated producer: retain the real host effect/journal, corrupt only its wire reply.
    ports.screen = async (raw, signal, guard) => {
      const result = await nativeScreen(raw, signal, guard);
      const request = JSON.parse(raw);
      return request.op === "command" && request.command.action === "input"
        ? JSON.stringify({ outcome: "confirmed" })
        : result;
    };
  }
  let connected = false;
  let failure: unknown;
  const controls = new PassThrough();
  const events: Array<ReturnType<typeof MachineJoinEventSchema.parse>> = [];
  await saveJoinedMachineCredential(f.store, credential);
  const running = (
    json
      ? runJoinCommand(["resume", "--json"], {
          joinCredentialStore: f.store,
          signal: abort.signal,
          ports,
          intervalMs: 10,
          stdin: controls,
          stdout: {
            write(value) {
              const event = MachineJoinEventSchema.parse(JSON.parse(String(value)));
              events.push(event);
              if (event.event === "joined") connected = true;
              return true;
            },
          },
          stderr: {
            write() {
              failure = Error("JSON join refused");
              return true;
            },
          },
        })
      : runJoinedMachineChannel(credential, {
          store: f.store,
          signal: abort.signal,
          ports,
          intervalMs: 10,
          onConnected: () => {
            connected = true;
          },
        })
  ).catch((error) => {
    failure = error;
  });
  await until(() => connected || failure !== undefined);
  if (failure) throw failure;
  const request = async (
    command: unknown,
    conversationId = "owner-session",
    machineId = credential.lease.machineId,
    authenticated = true,
  ) => {
    const response = await fetch(f.gateway + "/v1/computer", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: `Bearer ${owner}` } : {}),
      },
      body: JSON.stringify({ conversationId, machineId, command }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    ...f,
    credential,
    request,
    abort,
    running,
    controls,
    events,
    actions: async () =>
      (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    async stop() {
      abort.abort();
      await running;
      await f.close();
      if (failure) throw failure;
    },
  };
}

test("real encrypted computer API requires local session consent, preserves read-only and reassembles bounded PNG chunks", async () => {
  const f = await screenFixture("observe");
  try {
    expect(
      (await f.request({ action: "acquire" }, "owner-session", f.credential.lease.machineId, false)).status,
    ).toBe(401);
    expect((await f.request({ action: "acquire" }, "owner-session", "join-" + randomUUID())).status).toBe(
      409,
    );
    const acquired = await runComputerCommand(
      [
        "request",
        JSON.stringify({
          conversationId: "owner-session",
          machineId: f.credential.lease.machineId,
          command: { action: "acquire" },
        }),
      ],
      { host: f.gateway, env: { CLANKIE_OPERATOR_TOKEN: owner } },
    );
    expect(acquired).toMatchObject({ outcome: "acquired", lease: { allowInput: false } });
    const leaseId = ComputerLeaseSchema.parse((acquired as { lease: unknown }).lease).leaseId;
    expect((await f.request({ action: "inventory", leaseId })).body.apps[0].name).toBe("Fixture");
    const captured = await f.request({
      action: "capture",
      leaseId,
      target: { appId: "123", windowId: "456" },
    });
    expect(captured.status).toBe(200);
    expect(captured.body.inputReady).toBe(false);
    const frame = await f.request({ action: "frame", leaseId, screenshotId: captured.body.screenshotId });
    expect(frame.status).toBe(200);
    expect(frame.body.byteLength).toBeGreaterThan(8192);
    expect(frame.body.sha256).toBe(captured.body.sha256);
    expect(Buffer.from(frame.body.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(
      (
        await f.request({
          action: "input",
          leaseId,
          screenshotId: captured.body.screenshotId,
          requestId: randomUUID(),
          inputs: [
            {
              kind: "type",
              foreground: true,
              text: "never",
              expect: { field: "document_text", equals: "after" },
            },
          ],
        })
      ).status,
    ).toBe(409);
    expect((await f.actions()).filter((value) => value.action === "input")).toHaveLength(0);
    expect((await f.request({ action: "inventory", leaseId }, "foreign-session")).status).toBe(409);
    await f.machines.setAccess(f.credential.lease.machineId, { accessLevel: "portal" });
    expect(
      (await f.request({ action: "capture", leaseId, target: { appId: "123", windowId: "456" } })).status,
    ).toBe(403);
    expect((await f.request({ action: "release", leaseId })).body.outcome).toBe("released");
  } finally {
    await f.stop();
  }
});

test("input opt-in supports one exact receipt, refuses raw primitives, and keeps an uncertain Stop held without replay", async () => {
  const f = await screenFixture("drive", "uncertain");
  try {
    const leaseId = (await f.request({ action: "acquire" })).body.lease.leaseId;
    const capture = async () =>
      (await f.request({ action: "capture", leaseId, target: { appId: "123", windowId: "456" } })).body;
    for (const input of [
      { kind: "key", keys: "Enter" },
      { kind: "drag", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
      { kind: "scroll", direction: "down", amount: 1 },
    ]) {
      const shot = await capture();
      const refused = await f.request({
        action: "input",
        leaseId,
        screenshotId: shot.screenshotId,
        requestId: randomUUID(),
        inputs: [{ ...input, foreground: true, expect: { field: "document_text", equals: "after" } }],
      });
      expect(refused.body.outcome).toBe("failed");
    }
    const shot = await capture(),
      requestId = randomUUID();
    const command = {
      action: "input",
      leaseId,
      screenshotId: shot.screenshotId,
      requestId,
      inputs: [
        {
          kind: "type",
          text: "after",
          foreground: true,
          expect: { field: "document_text", equals: "after" },
        },
      ],
    };
    const first = await f.request(command);
    expect(first.body.outcome).toBe("confirmed");
    expect((await f.request(command)).body).toEqual(first.body);
    expect((await f.actions()).filter((value) => value.action === "input")).toHaveLength(1);
    await f.machines.setAccess(f.credential.lease.machineId, { accessLevel: "portal" });
    expect((await f.request({ action: "revoke", leaseId })).body).toEqual({
      outcome: "rejected",
      reason: "recovery_required",
    });
    expect((await f.request({ action: "status" })).body.lease.state).toBe("recovery_required");
    expect((await f.request(command)).status).toBe(403);
    expect((await f.actions()).filter((value) => value.action === "input")).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

test("a malformed claimed effect receipt refuses without replaying the host input", async () => {
  const f = await screenFixture("drive", "uncertain", false, true);
  try {
    const leaseId = (await f.request({ action: "acquire" })).body.lease.leaseId;
    const shot = (await f.request({ action: "capture", leaseId, target: { appId: "123", windowId: "456" } }))
      .body;
    const command = {
      action: "input",
      leaseId,
      screenshotId: shot.screenshotId,
      requestId: randomUUID(),
      inputs: [
        {
          kind: "type",
          text: "after",
          foreground: true,
          expect: { field: "document_text", equals: "after" },
        },
      ],
    };
    expect((await f.request(command)).status).toBe(409);
    expect((await f.request(command)).status).toBe(409);
    expect((await f.actions()).filter((value) => value.action === "input")).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

test("refused or delayed local consent cannot be manufactured by the authenticated service", async () => {
  const denied = await screenFixture("deny");
  try {
    expect((await denied.request({ action: "acquire" })).status).toBe(409);
    expect((await denied.request({ action: "status" })).body.lease).toBeNull();
  } finally {
    await denied.stop();
  }
  const delayed = await screenFixture("wait");
  try {
    const acquiring = delayed.request({ action: "acquire" });
    await until(async () => (await delayed.actions()).some((value) => value.action === "consent"));
    await delayed.machines.setAccess(delayed.credential.lease.machineId, { accessLevel: "portal" });
    expect((await acquiring).status).toBe(403);
    expect((await delayed.request({ action: "status" })).body.lease).toBeNull();
    expect((await delayed.actions()).filter((value) => value.action === "bind")).toHaveLength(0);
  } finally {
    await delayed.stop();
  }
});

test("local pet Stop fences a queued fresh-frame input before dispatch and uncertain proof keeps the lease held", async () => {
  const f = await screenFixture("drive-stop", "uncertain");
  try {
    const leaseId = (await f.request({ action: "acquire" })).body.lease.leaseId;
    const shot = (await f.request({ action: "capture", leaseId, target: { appId: "123", windowId: "456" } }))
      .body;
    const observing = f.request({ action: "inventory", leaseId });
    await until(async () => (await f.actions()).some((value) => value.action === "inventory"));
    const queued = f.request({
      action: "input",
      leaseId,
      screenshotId: shot.screenshotId,
      requestId: randomUUID(),
      inputs: [
        {
          kind: "type",
          foreground: true,
          text: "never",
          expect: { field: "document_text", equals: "after" },
        },
      ],
    });
    expect((await observing).status).toBe(409);
    expect((await queued).status).toBe(409);
    expect((await f.actions()).filter((value) => value.action === "input")).toHaveLength(0);
    expect((await f.request({ action: "status" })).body.lease.state).toBe("recovery_required");
    expect((await f.request({ action: "recover" })).body).toEqual({
      outcome: "rejected",
      reason: "recovery_required",
    });
  } finally {
    await f.stop();
  }
});

test("a restarted native process cannot clear an older uncertain session by claiming an empty queue", async () => {
  const f = await screenFixture("drive", "uncertain");
  const bodyDirectory = join(f.root, "body");
  try {
    const leaseId = (await f.request({ action: "acquire" })).body.lease.leaseId;
    const shot = (await f.request({ action: "capture", leaseId, target: { appId: "123", windowId: "456" } }))
      .body;
    await f.request({
      action: "input",
      leaseId,
      screenshotId: shot.screenshotId,
      requestId: randomUUID(),
      inputs: [
        {
          kind: "type",
          foreground: true,
          text: "after",
          expect: { field: "document_text", equals: "after" },
        },
      ],
    });
    f.abort.abort();
    await f.running;
    const ports = createJoinedScreenPorts({
      machineId: f.credential.lease.machineId,
      directory: bodyDirectory,
      executable: process.execPath,
      args: [
        join(import.meta.dirname, "fixtures/lent-screen-provider.mjs"),
        "observe",
        join(f.root, "restart-actions.jsonl"),
        "certain",
      ],
    });
    try {
      const reply = JSON.parse(
        await ports.screen!(
          JSON.stringify({ op: "command", conversationId: "owner-session", command: { action: "recover" } }),
          new AbortController().signal,
          () => {
            throw Error("no screen policy");
          },
        ),
      );
      expect(reply).toEqual({ outcome: "rejected", reason: "recovery_required" });
    } finally {
      await ports.closeScreen!();
    }
  } finally {
    await f.stop();
  }
});

test("supervised JSON join exposes finite registration, local status and Stop without consent or lease capabilities", async () => {
  const f = await screenFixture("observe", "certain", true);
  try {
    let output = "";
    const stdout = {
      write(value: unknown) {
        output += String(value);
        return true;
      },
    };
    expect(await runJoinCommand(["status", "--json"], { joinCredentialStore: f.store, stdout })).toBe(0);
    expect(JSON.parse(output)).toEqual({
      configured: true,
      machineId: f.credential.lease.machineId,
      origin: f.origin,
    });
    const leaseId = (await f.request({ action: "acquire" })).body.lease.leaseId;
    const statusId = randomUUID();
    f.controls.write(JSON.stringify({ id: statusId, action: "screen_status" }) + "\n");
    await until(() => f.events.some((event) => event.event === "screen" && event.id === statusId));
    const status = f.events.find((event) => event.event === "screen" && event.id === statusId);
    if (status?.event !== "screen") throw Error("Missing local status");
    expect(status.result).toMatchObject({
      outcome: "status",
      available: true,
      allowInput: false,
      inputReady: false,
      lease: { conversationId: "owner-session", state: "active" },
    });
    expect(JSON.stringify(status)).not.toContain(leaseId);
    const stopId = randomUUID();
    f.controls.write(JSON.stringify({ id: stopId, action: "screen_stop" }) + "\n");
    await until(() => f.events.some((event) => event.event === "screen" && event.id === stopId));
    const stop = f.events.find((event) => event.event === "screen" && event.id === stopId);
    if (stop?.event !== "screen") throw Error("Missing local Stop receipt");
    expect(stop.result).toMatchObject({ outcome: "released", lease: null, inputReady: false });
    expect((await f.actions()).filter((value) => value.action === "input")).toHaveLength(0);
    const closed = new Promise<void>((resolve) => f.controls.once("end", resolve));
    f.controls.end();
    await closed;
    expect((await f.request({ action: "acquire" })).status).toBe(409);
    expect((await f.actions()).filter((value) => value.action === "consent")).toHaveLength(1);
    f.abort.abort();
    await f.running;
    output = "";
    expect(await runJoinCommand(["leave", "--json"], { joinCredentialStore: f.store, stdout })).toBe(0);
    expect(JSON.parse(output)).toEqual({ ok: true, left: true });
    output = "";
    expect(await runJoinCommand(["status", "--json"], { joinCredentialStore: f.store, stdout })).toBe(0);
    expect(JSON.parse(output)).toEqual({ configured: false });
  } finally {
    await f.stop();
  }
});

test("unknown local control and lost app stdin fence input and leave an uncertain session held", async () => {
  const f = await screenFixture("drive", "uncertain", true);
  try {
    const leaseId = (await f.request({ action: "acquire" })).body.lease.leaseId;
    f.controls.write(JSON.stringify({ id: randomUUID(), action: "screen_allow_input" }) + "\n");
    await until(
      async () => (await f.request({ action: "status" })).body.lease?.state === "recovery_required",
    );
    expect(
      (await f.request({ action: "capture", leaseId, target: { appId: "123", windowId: "456" } })).status,
    ).toBe(409);
    const stopId = randomUUID();
    f.controls.write(JSON.stringify({ id: stopId, action: "screen_stop" }) + "\n");
    await until(() => f.events.some((event) => event.event === "screen" && event.id === stopId));
    const stop = f.events.find((event) => event.event === "screen" && event.id === stopId);
    if (stop?.event !== "screen") throw Error("Missing held receipt");
    expect(stop.result).toMatchObject({
      outcome: "held",
      allowInput: false,
      inputReady: false,
      lease: { state: "recovery_required" },
    });
    f.controls.end();
    expect((await f.request({ action: "status" })).body.lease.state).toBe("recovery_required");
    expect((await f.actions()).filter((value) => value.action === "input")).toHaveLength(0);
  } finally {
    await f.stop();
  }
});
