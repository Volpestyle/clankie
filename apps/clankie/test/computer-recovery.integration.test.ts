import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { ComputerLeaseSchema } from "@clankie/interactive-environment";
import { runComputerCommand } from "../../tui/src/command/computer.ts";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { ComputerBody, type OwnerComputerRecovery } from "../src/computer-body.ts";
import { computerRoutes } from "../src/computer-http.ts";
import { PeekabooComputerAdapter } from "../src/computer-peekaboo.ts";
import { WindowsComputerAdapter } from "../src/computer-windows.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Real lease/journal, conversation turn tracking, owner bearer verification, HTTP and CLI.
// Peekaboo's ordinary stop is exercised; owner override performs no native input or daemon stop.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "computer-owner-recovery-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const entered = deferred(),
    finished = deferred();
  const conversations = new ConversationStore(join(root, "conversations"), async () => {
    entered.resolve();
    await finished.promise;
  });
  cleanup.push(async () => {
    finished.resolve();
    await conversations.close();
  });
  let clock = Date.now() - 3 * 86400_000;
  const store = new BodyLeaseStore(join(root, "leases"), () => clock);
  cleanup.push(async () => store.close());
  const acquired = store.acquire("computer", "global-default", 1000);
  if (acquired.outcome !== "acquired") throw Error("No old computer lease");
  const held = acquired.lease;
  const expiresAt = acquired.expiresAt;
  clock = Date.now();
  const body = new ComputerBody(new PeekabooComputerAdapter(), store, join(root, "journal"));
  const captain = createStubCaptain(); // Unrelated app ports; recovery uses the real conversation store.
  captain.seatContext = (id) => (id && conversations.has(id) ? { conversationId: id, cwd: root } : undefined);
  captain.validateConversationOwner = async ({ conversationId }) => conversations.has(conversationId);
  captain.conversationServiceTrackedIdle = (id) => conversations.serviceTrackedIdle(id);
  const bearer = randomUUID();
  const authenticate = createBearerAuthenticator(bearer, { operatorId: "recovery-owner" });
  let authorization: "owner" | "revoked" | "other" = "owner";
  let beforeAuth: (() => void) | undefined;
  const app = await createClankieApp({
    captain,
    extensionRoutes: [computerRoutes({ body })],
    authenticateOperator: async (request) => {
      beforeAuth?.();
      const identity = await authenticate(request);
      return !identity || authorization === "revoked"
        ? undefined
        : authorization === "other"
          ? { operatorId: "different-owner" }
          : identity;
    },
  });
  cleanup.push(() => app.close());
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No computer HTTP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { CLANKIE_OPERATOR_TOKEN: bearer, CLANKIE_CONTROL_PLANE_URL: origin, HOME: root, PATH: "" };
  const request = (command: unknown, token: string = bearer) =>
    fetch(`${origin}/v1/computer`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "global-default", command }),
    });
  const command = {
    action: "recover",
    ownerRecovery: {
      reason:
        "Owner confirms old native driver has stopped; accept unresolved Peekaboo drain for the expired lease.",
      expectedHolder: "global-default",
      expectedExpiresAt: expiresAt,
    },
  };
  const cli = (value: unknown) =>
    runComputerCommand(["request", JSON.stringify({ conversationId: "global-default", command: value })], {
      env,
    });
  const identity = {
    conversationId: "global-default",
    route: { owner: { conversationId: "global-default" }, mode: "machine" as const },
    current: () => true,
    authorize: async () => true,
  };
  const authority: OwnerComputerRecovery = {
    operatorId: "recovery-owner",
    authorize: async () => true,
    holderIdle: (id) => conversations.serviceTrackedIdle(id),
  };
  return {
    root,
    store,
    held,
    body,
    conversations,
    entered,
    finished,
    command,
    request,
    cli,
    identity,
    authority,
    hookAuth: (hook: () => void) => {
      beforeAuth = hook;
    },
    revoke: () => {
      authorization = "revoked";
    },
    changeOwner: () => {
      authorization = "other";
    },
  };
}

it("recovers an expired native Mac claim through owner HTTP/CLI, durably records the reason, and permits a fresh acquire", async () => {
  const f = await fixture();
  f.conversations.syncNativeSeatTranscript("global-default", "native-owner", [], "waiting");
  expect(f.conversations.turnIdle("global-default")).toBe(false); // Automatic recovery still refuses native ownership.
  const refusal = await f.cli({ action: "recover" });
  expect(refusal).toMatchObject({
    outcome: "rejected",
    reason: "recovery_required",
    detail: expect.stringContaining("cannot prove"),
    next: expect.stringContaining("ownerRecovery"),
  });
  expect(f.store.status("computer")?.state).toBe("recovery_required");
  const result = await f.cli(f.command);
  expect(result).toMatchObject({ outcome: "released", recovery: { kind: "owner_override" } });
  const audit = JSON.parse(
    (await readFile(join(f.root, "journal/computer-recoveries.jsonl"), "utf8")).trim(),
  );
  expect(audit).toMatchObject({
    decision: "owner_override_authorized",
    operatorId: "recovery-owner",
    originalHolder: "global-default",
    reason: f.command.ownerRecovery.reason,
    expiresAt: f.command.ownerRecovery.expectedExpiresAt,
  });
  expect(JSON.stringify(result)).not.toContain(f.held.token);
  const next = (await f.cli({ action: "acquire" })) as { lease: unknown };
  const lease = ComputerLeaseSchema.parse(next.lease);
  expect(lease.leaseId).not.toBe(f.held.token);
  expect(await f.cli(f.command)).toMatchObject({ reason: "recovery_not_idle" });
  expect(await f.cli({ action: "release", leaseId: lease.leaseId })).toEqual({ outcome: "released" });
  f.store.close();
  const restarted = new BodyLeaseStore(join(f.root, "leases"));
  try {
    expect(restarted.status("computer")).toBeUndefined();
  } finally {
    restarted.close();
  }
  expect(await readFile(join(f.root, "journal/computer-recoveries.jsonl"), "utf8")).toContain(audit.auditId);
  console.info("Mac owner recovery proof", JSON.stringify({ refusal, result, audit, freshAcquire: next }));
});

it("refuses unauthenticated requests, empty reasons, stale expectations and tool identities without independent owner authority", async () => {
  const f = await fixture();
  expect((await f.request(f.command, "not-owner")).status).toBe(401);
  expect(
    (await f.request({ ...f.command, ownerRecovery: { ...f.command.ownerRecovery, reason: " " } })).status,
  ).toBe(400);
  expect(
    await (
      await f.request({ ...f.command, ownerRecovery: { ...f.command.ownerRecovery, expectedExpiresAt: 1 } })
    ).json(),
  ).toMatchObject({ reason: "recovery_not_idle", next: expect.any(String) });
  expect(await f.body.dispatch(f.identity, f.command)).toMatchObject({
    reason: "owner_authorization_required",
  });
  expect(f.store.status("computer")?.state).toBe("recovery_required");
});

it("refuses real service turns and pinned body operations, then permits recovery once both settle", async () => {
  const f = await fixture();
  const submitted = f.conversations.submitInternal("global-default", "hold recovery", "wake");
  if (submitted.status !== "accepted") throw Error("No service turn");
  await f.entered.promise;
  expect(await f.cli(f.command)).toMatchObject({ reason: "recovery_not_idle" });
  f.finished.resolve();
  await f.conversations.awaitRun(submitted.runId);
  const operation = f.store.beginRecovery(f.held);
  if (operation.outcome !== "admitted") throw Error("No pinned operation");
  expect(await f.cli(f.command)).toMatchObject({ reason: "recovery_not_idle" });
  f.store.finish(f.held, operation.operationId, "settled");
  expect(await f.cli(f.command)).toMatchObject({ outcome: "released" });
});

it.each(["revoked", "changed"])("rechecks %s operator authority while recovery is awaited", async (mode) => {
  const f = await fixture();
  let reads = 0;
  // Initial route authentication, owner binding, ordinary identity grant, then bound operator recheck.
  f.hookAuth(() => {
    if (++reads === 4) {
      if (mode === "revoked") f.revoke();
      else f.changeOwner();
    }
  });
  expect(await f.cli(f.command)).toMatchObject({ reason: "owner_recovery_refused" });
  expect(f.store.status("computer")?.state).toBe("recovery_required");
});

it("keeps the exact claim held if the audit cannot be persisted, and fences replacement during an awaited guard", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "journal/computer-recoveries.jsonl"));
  expect(await f.cli(f.command)).toMatchObject({ reason: "owner_recovery_refused" });
  expect(f.store.recoveryReference("computer")?.token).toBe(f.held.token);
  await rm(join(f.root, "journal/computer-recoveries.jsonl"), { recursive: true });
  await writeFile(join(f.root, "journal/computer-recoveries.jsonl"), '{"schemaVersion":1');
  expect(await f.cli(f.command)).toMatchObject({ reason: "owner_recovery_refused" });
  expect(f.store.recoveryReference("computer")?.token).toBe(f.held.token);
  await rm(join(f.root, "journal/computer-recoveries.jsonl"));
  const result = await f.body.dispatch(f.identity, f.command, {
    ...f.authority,
    authorize: async () => {
      f.store.reconcileStopped(f.held);
      f.store.acquire("computer", "new-holder", 300000);
      return true;
    },
  });
  expect(result).toMatchObject({ reason: "recovery_not_idle" });
  expect(f.store.status("computer")).toMatchObject({ conversationId: "new-holder", state: "active" });
});

it("serializes concurrent recovery and refuses the Mac override for a Windows adapter", async () => {
  const f = await fixture();
  const entered = deferred(),
    finish = deferred();
  const pending = f.body.dispatch(f.identity, f.command, {
    ...f.authority,
    authorize: async () => {
      entered.resolve();
      await finish.promise;
      return true;
    },
  });
  await entered.promise;
  expect(await f.cli(f.command)).toMatchObject({ reason: "operation_in_progress" });
  finish.resolve();
  expect(await pending).toMatchObject({ outcome: "released" });
  const unavailable = async () => {
    throw Error("No native Windows operation is authorized in this fixture");
  };
  const windows = new ComputerBody(
    new WindowsComputerAdapter(
      { target: "windows", list_apps: unavailable, get_window_state: unavailable },
      "fixture",
    ),
    f.store,
    join(f.root, "windows"),
  );
  expect(await windows.dispatch(f.identity, f.command, f.authority)).toMatchObject({
    reason: "owner_recovery_unsupported",
  });
});
