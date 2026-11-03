import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  resolveCaptainCredential,
  resolveOperatorCredential,
  inspectOperatorCredential,
} from "@clankie/credential-broker";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { EvidenceStore } from "../src/evidence-store.ts";
import type { FleetResourceRuntime } from "../src/fleet-resource-runtime.ts";
import { runEvidenceCommand } from "../../tui/src/command/evidence.ts";
import { runAgentsCommand } from "../../tui/src/command/agents.ts";
import { runSimulatorCommand } from "../../tui/src/command/fleet-resources.ts";
import { runWorkCommand } from "../../tui/src/command/work.ts";
import { runReviewCommand } from "../../tui/src/command/review.ts";
import { resolveSeatContext } from "../../tui/src/command/seat-context.ts";
import { runSeatDeliveryCommand } from "../../tui/src/command/seat-delivery.ts";

const exec = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("refuses owner credentials and owner-seat commands before opening a worker's broker, even with env overrides", async () => {
  const get = vi.fn(async () => {
    throw new Error("BROKER MUST NOT BE OPENED");
  });
  const store = { get, set: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as FileCredentialStore;
  const env = {
    CLANKIE_WORKER_PANE: "1",
    CLANKIE_OPERATOR_TOKEN: "owner-token",
    CLANKIE_CAPTAIN_TOKEN: "captain-token",
  };
  await expect(resolveOperatorCredential({ env, store })).rejects.toMatchObject({ code: "worker_pane" });
  await expect(resolveCaptainCredential({ env, store })).rejects.toMatchObject({ code: "worker_pane" });
  await expect(inspectOperatorCredential({ env, store })).rejects.toMatchObject({ code: "worker_pane" });
  await expect(
    resolveSeatContext(
      { cwd: "/scratch", command: "codex", dryRun: true },
      {
        repoRoot: "/scratch",
        env,
        operatorCredentialStore: store,
      },
    ),
  ).rejects.toMatchObject({ code: "worker_pane" });
  await expect(
    runSeatDeliveryCommand(["list"], { env, captainCredentialStore: store }),
  ).rejects.toMatchObject({ code: "worker_pane" });
  await expect(
    runReviewCommand(["waive", "--reason", "not allowed"], { env, operatorCredentialStore: store }),
  ).rejects.toMatchObject({ code: "worker_pane" });
  expect(get).not.toHaveBeenCalled();
});

it("uses a pane link through real HTTP for evidence and receipts, and scopes simulator effects to that pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-cli-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(join(repo, "docs/testing/proof"), { recursive: true });
  await exec("git", ["init", repo]);
  const capture = join(repo, "docs/testing/proof/capture.log");
  await writeFile(capture, "disposable worker evidence\n".repeat(1024));
  const store = EvidenceStore.local(join(root, "evidence"));
  cleanup.push(async () => store.close());
  const pane = "w1:p1";
  let live = true;
  const proof = {
    fleet: "default",
    pane,
    nativeOccupantId: "fixture-native-session",
    binding: { socketPath: "fixture" },
    processes: [{ pid: 2, startTime: "fixture" }],
    shell: { pid: 1, startTime: "fixture" },
  };
  const link = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => undefined,
    prove: async (_socket, requested) => live && requested === pane,
    projectProof: async () => (live ? proof : undefined),
  });
  const release = vi.fn(async () => ({ outcome: "released" }));
  const resources = {
    proveSimulatorSeat: vi.fn(async () => ({ seatId: pane, occupantId: proof.nativeOccupantId })),
    simulators: { release },
  } as unknown as FleetResourceRuntime;
  const deliveryId = randomUUID();
  const app = await createClankieApp({
    captain: createStubCaptain({
      fleetSeatEvidenceActor: async (authority) =>
        (await authority.validate())
          ? {
              kind: "seat",
              id: "worker-fixture",
              name: "Worker fixture",
              onBehalfOf: [{ kind: "conversation", id: "fixture-lead" }],
            }
          : undefined,
      fleetSeatMessageStatus: async (requested, id) =>
        requested === pane && id === deliveryId
          ? { schemaVersion: 1, deliveryId, deliveryStage: "consumed" }
          : undefined,
    }),
    evidenceStore: store,
    localFleet: link,
    fleetResources: resources,
    authenticateOperator: async () => undefined,
    authenticateCaptain: async () => undefined,
  });
  cleanup.push(async () => app.close());
  const seen: { path: string; authorization: string | null; pane: string | null }[] = [];
  const calls: unknown[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, env) => {
      const path = new URL(request.url).pathname;
      seen.push({
        path,
        authorization: request.headers.get("authorization"),
        pane: request.headers.get("x-clankie-pane"),
      });
      // The native bridge's HTTP transport is real; this fixture supplies a tool receipt.
      // Role and actor enforcement remain in the existing WorkerMcp integration checks.
      if (path === "/v1/fleet/mcp") {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const message = (await request.json()) as { id?: number; method: string; params?: unknown };
        if (message.id === undefined) return new Response(null, { status: 202 });
        if (message.method === "tools/call") calls.push(message.params);
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fixture", version: "1" },
                  }
                : { content: [], structuredContent: { outcome: "uncertain", receiptId: "original-receipt" } },
          },
          { headers: { "mcp-session-id": "worker-cli-fixture" } },
        );
      }
      return link.fetch(app.app.fetch)(request, env);
    },
  });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const state = join(root, "state");
  await mkdir(join(state, "links"), { recursive: true });
  const socket = join(root, "herdr.sock");
  await writeFile(
    join(state, "links/local.json"),
    JSON.stringify({
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "default",
      socket,
      url: `http://127.0.0.1:${address.port}`,
    }),
  );
  const env = {
    CLANKIE_WORKER_PANE: "1",
    CLANKIE_STATE: state,
    HERDR_PANE_ID: pane,
    HERDR_SOCKET_PATH: socket,
    CLANKIE_OPERATOR_TOKEN: "inherited-owner-must-not-be-used",
    CLANKIE_CAPTAIN_TOKEN: "inherited-captain-must-not-be-used",
  };
  const output = await runEvidenceCommand(["push", capture, "--issue", "LOCAL-1"], {
    cwd: repo,
    env,
    stderr: { write() {} },
  });
  expect(output.ok).toBe(true);
  const records = await store.list({ issueKey: "LOCAL-1" });
  expect(records).toHaveLength(1);
  expect(records[0]?.actor).toMatchObject({
    kind: "seat",
    id: "worker-fixture",
    onBehalfOf: [{ kind: "conversation", id: "fixture-lead" }],
  });
  expect(await readFile(join(repo, "docs/testing/proof/evidence.json"), "utf8")).toContain(
    "clankie://evidence/",
  );
  expect(await runAgentsCommand(["message-status", deliveryId], { env })).toMatchObject({
    deliveryStage: "consumed",
  });
  if (process.platform === "darwin") {
    const denied = join(root, "dummy-credentials.json");
    await writeFile(denied, "{}");
    const profile = `(version 1)(allow default)(deny file-read* (literal ${JSON.stringify(await realpath(denied))}))`;
    const probe = await exec(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        process.execPath,
        "--import",
        import.meta.resolve("tsx/esm"),
        join(import.meta.dirname, "fixtures/worker-cli-sandbox-probe.ts"),
        denied,
        deliveryId,
      ],
      {
        env: { ...process.env, ...env },
      },
    );
    expect(probe.stdout).toContain("zero broker reads");
    const cli = await exec(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        process.execPath,
        "--import",
        import.meta.resolve("tsx/esm"),
        join(import.meta.dirname, "../../tui/bin/clankie.ts"),
        "agents",
        "message-status",
        deliveryId,
      ],
      {
        env: { ...process.env, ...env, CLANKIE_CREDENTIALS_FILE: denied },
      },
    );
    expect(JSON.parse(cli.stdout)).toMatchObject({ deliveryStage: "consumed" });
    await expect(
      exec(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          process.execPath,
          "--import",
          import.meta.resolve("tsx/esm"),
          join(import.meta.dirname, "../../tui/bin/clankie.ts"),
          "claude",
          "--dry-run",
        ],
        {
          env: { ...process.env, ...env, CLANKIE_CREDENTIALS_FILE: denied },
        },
      ),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("owner's terminal") });
  }
  expect(
    await runSimulatorCommand(["release", JSON.stringify({ seatId: pane, id: "lease-fixture" })], { env }),
  ).toEqual({ outcome: "released" });
  await expect(
    runSimulatorCommand(["release", JSON.stringify({ seatId: "somebody-else", id: "lease-fixture" })], {
      env,
    }),
  ).rejects.toThrow("HTTP 403");
  expect(release).toHaveBeenCalledTimes(1);
  expect(
    await runWorkCommand(["call", "get_issue", "--json", '{"id":"LOCAL-1"}'], { env, cwd: repo }),
  ).toEqual({ ok: false, body: { outcome: "uncertain", receiptId: "original-receipt" } });
  expect(calls).toHaveLength(1); // No replay of a possibly applied call.
  expect(calls[0]).toMatchObject({
    name: "clankie_call",
    arguments: { name: "linear_get_issue", arguments: { id: "LOCAL-1" } },
    _meta: { clankieReceiptId: expect.any(String) },
  });
  let lostCalls = 0;
  let originalReceipt: unknown;
  const lost = await runWorkCommand(["call", "get_issue", "--json", '{"id":"LOCAL-1"}'], {
    env,
    cwd: repo,
    fetchImpl: async (input, init) => {
      const message = JSON.parse(String(init?.body)) as {
        method?: string;
        params?: { _meta?: { clankieReceiptId?: string } };
      };
      if (message.method === "tools/call") {
        lostCalls += 1;
        originalReceipt = message.params?._meta?.clankieReceiptId;
        throw new TypeError("fixture reply lost");
      }
      return fetch(input, init);
    },
  });
  expect(lostCalls).toBe(1);
  expect(originalReceipt).toEqual(expect.any(String));
  expect(lost).toMatchObject({ ok: false, body: { outcome: "uncertain", receiptId: originalReceipt } });
  await expect(
    runWorkCommand(["owner", "save_issue", "--json", '{"id":"LOCAL-1"}'], { env, cwd: repo }),
  ).rejects.toThrow("requires the owner");
  const raw = await fetch(`http://127.0.0.1:${address.port}/v1/work`, {
    method: "POST",
    headers: { "x-clankie-pane": pane, "content-type": "application/json" },
    body: JSON.stringify({ action: "init", repo }),
  });
  expect(raw.status).toBe(404); // The worker link never forwards owner work routes.
  live = false;
  await expect(
    runSimulatorCommand(["release", JSON.stringify({ seatId: pane, id: "lease-fixture" })], { env }),
  ).rejects.toThrow("HTTP 403");
  expect(release).toHaveBeenCalledTimes(1);
  expect(seen.every((request) => request.authorization === null)).toBe(true);
  expect(seen.every((request) => request.pane === pane)).toBe(true);
});
