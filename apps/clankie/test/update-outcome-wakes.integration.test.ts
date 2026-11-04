import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore, mintOperatorToken, setLeadWake } from "@clankie/credential-broker";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { runUpdateCommand } from "../../tui/src/command/update.ts";
import { writeRuntimeUpdate, type RuntimeUpdateResult } from "../../tui/bin/runtime-update.ts";
import type { RuntimeUpdater, UpdateAuthority } from "../../tui/bin/runtime-updater.ts";
import { writePrivateJson } from "../../tui/bin/update-files.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { DeployHolds } from "../src/deploy-holds.ts";
import { createLeadWakes } from "../src/lead-wakes.ts";
import { RuntimeCanary } from "../src/runtime-canary.ts";
import { createRuntimeHealthSampler } from "../src/runtime-health-sample.ts";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";

// How an update ends reaches a lead (ADR 0355), over the real path: the CLI's --notify
// crosses the HTTP route into the operation's initiator, and the canary, run on real
// health samples, wakes a real webhook through the credential broker's stored lead.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-update-wake-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const updates = join(root, "updates");
  await mkdir(updates, { mode: 0o700 });
  const runtime = { root, commit: "b".repeat(40), instanceId: randomUUID(), pid: process.pid };

  const received: Array<{ lead: string; kind: string; text: string; reply?: string }> = [];
  let answer = 200;
  const webhook = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += String(chunk)));
    request.on("end", () => {
      received.push(JSON.parse(body) as (typeof received)[number]);
      response.statusCode = answer;
      response.end("{}");
    });
  });
  webhook.listen(0, "127.0.0.1");
  await once(webhook, "listening");
  cleanup.push(async () => {
    webhook.closeAllConnections();
    await new Promise<void>((resolve) => webhook.close(() => resolve()));
  });
  const store = new FileCredentialStore(join(root, "credentials.json"));
  const url = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/hook`;
  await setLeadWake(store, "duet", { url, authorization: "Bearer key" });
  await setLeadWake(store, "grok", { url, authorization: "Bearer key" });
  const warnings: Array<Record<string, unknown>> = [];
  const wakes = createLeadWakes({ store, warn: (fields) => warnings.push(fields) });

  const token = mintOperatorToken();
  const authenticate = createBearerAuthenticator(token, { operatorId: "update-wake-owner" });
  const holds = new DeployHolds(join(root, "integration"));
  const requested: UpdateAuthority[] = [];
  const updater = {
    runtime,
    status: () => ({ phase: "idle" }),
    request: async (_ref: string, authority: UpdateAuthority) => {
      requested.push(authority);
      return { phase: "idle", accepted: true };
    },
  } as unknown as RuntimeUpdater;
  const app = new Hono();
  app.get("/health", (context) => context.json({ ok: true, service: "clankie", runtime }));
  app.route(
    "/",
    createRuntimeUpdateRoutes({
      updater,
      leads: () => wakes.leads(),
      authorize: async (request) =>
        (await authenticate(request))
          ? {
              initiator: { kind: "cli", operatorId: "update-wake-owner" },
              current: () => true,
              guard: async () => {},
            }
          : undefined,
    }),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let appsLead = false;
  const alerts: string[] = [];
  const canary = () => {
    const created = new RuntimeCanary({
      updatesDirectory: updates,
      runtime,
      holds,
      sample: createRuntimeHealthSampler({ healthUrl: `${host}/health` }),
      pressure: () => ({ load1: 0, load15: 0, cores: 8 }),
      alert: async (text) => {
        alerts.push(text);
        return true;
      },
      wake: (text, lead) => wakes.updateOutcome({ text, ...(lead === undefined ? {} : { lead }), appsLead }),
    });
    cleanup.push(() => created.close());
    return created;
  };
  const operation = async (fields: Partial<RuntimeUpdateResult>) => {
    const id = randomUUID();
    const directory = join(updates, id);
    await mkdir(directory, { mode: 0o700 });
    writePrivateJson(join(updates, "latest.json"), { id });
    writeRuntimeUpdate(directory, {
      id,
      ref: "main",
      oldCommit: "a".repeat(40),
      newCommit: runtime.commit,
      phase: "healthy",
      healthy: true,
      ...(fields.phase === undefined ? { canary: { state: "pending" } } : {}),
      updatedAt: new Date().toISOString(),
      ...fields,
    } as RuntimeUpdateResult);
    return { id, directory };
  };
  return {
    updates,
    received,
    warnings,
    alerts,
    requested,
    canary,
    operation,
    cli: (args: string[]) => runUpdateCommand(args, { host, env: { CLANKIE_OPERATOR_TOKEN: token } }),
    policy: (policy: Record<string, number>) => writePrivateJson(join(updates, "canary-policy.json"), policy),
    leadByApps: () => {
      appsLead = true;
    },
    refuseWakes: () => {
      answer = 500;
    },
  };
}

it("takes --notify onto the update's initiator, and refuses a lead with no stored webhook", async () => {
  const f = await fixture();
  const refused = (await f.cli(["now", "--notify", "finance"])) as Record<string, unknown>;
  expect(refused).toMatchObject({ accepted: false, error: "unknown_lead", leads: ["duet", "grok"] });
  expect(refused.detail).toContain("No lead goes by finance. --notify can name: duet, grok.");
  expect(f.requested).toEqual([]);

  expect(await f.cli(["now", "--notify", "Duet"])).toMatchObject({ accepted: true });
  expect(f.requested[0]?.initiator).toEqual({
    kind: "cli",
    operatorId: "update-wake-owner",
    notifyLead: "duet",
  });
});

it("wakes only the named lead when a canary passes on real samples, once, without the conversation", async () => {
  const f = await fixture();
  f.policy({ windowMs: 1000, sampleIntervalMs: 100 });
  const { id } = await f.operation({ initiator: { kind: "cli", notifyLead: "duet" } });
  const canary = f.canary();
  await canary.recover();
  canary.start();
  await expect.poll(() => f.received.length, { timeout: 10_000 }).toBe(1);
  expect(f.received[0]).toMatchObject({ lead: "duet", kind: "update_outcome", from: "clankie" });
  expect(f.received[0]!.text).toContain(`update=${id} outcome=passed`);
  expect(f.received[0]).not.toHaveProperty("reply");
  // The next ticks and a new boot see the same passed operation and say nothing more.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await canary.close();
  const next = f.canary();
  next.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(f.received).toHaveLength(1);
  expect(f.alerts).toEqual([]);
});

it("sends a passed canary to nobody while Clankie leads and no lead was named", async () => {
  const f = await fixture();
  f.policy({ windowMs: 1000, sampleIntervalMs: 100 });
  const { directory } = await f.operation({ initiator: { kind: "cli" } });
  const canary = f.canary();
  await canary.recover();
  canary.start();
  await expect
    .poll(() => existsSync(join(directory, "lead-wake-outcome.json")), { timeout: 10_000 })
    .toBe(true);
  expect(f.received).toEqual([]);
  expect(await readFile(join(directory, "lead-wake-outcome.json"), "utf8")).toContain("none");
});

it("routes a failed canary to every stored lead while apps lead, keeps its alert, and sends no error text", async () => {
  const f = await fixture();
  f.leadByApps();
  f.policy({ windowMs: 1000, sampleIntervalMs: 100, healthLatencyMs: 0.0001 });
  const { id } = await f.operation({ initiator: { kind: "cli" } });
  const canary = f.canary();
  await canary.recover();
  canary.start();
  await expect.poll(() => f.received.length, { timeout: 10_000 }).toBe(2);
  expect(f.received.map(({ lead }) => lead).sort()).toEqual(["duet", "grok"]);
  expect(f.received[0]!.text).toContain(
    `update=${id} outcome=failed from=aaaaaaaaa to=bbbbbbbbb reason=runtime-canary-latency-budget-exceeded`,
  );
  expect(f.received[0]!.text).not.toContain("clankie update release");
  await expect.poll(() => f.alerts.length).toBe(1);
  expect(f.alerts[0]).toContain("Runtime canary held further deploys");
});

it("tells the named lead of a rollback, without its error text", async () => {
  const f = await fixture();
  const { id } = await f.operation({
    phase: "rolled-back",
    healthy: false,
    rollbackHealthy: true,
    reason: "restart-failed",
    error: "/Users/owner/private/path failed",
    oldCommit: "b".repeat(40),
    newCommit: "c".repeat(40),
    initiator: { kind: "cli", notifyLead: "grok" },
  });
  f.canary().start();
  await expect.poll(() => f.received.length).toBe(1);
  expect(f.received[0]).toMatchObject({ lead: "grok", kind: "update_outcome" });
  expect(f.received[0]!.text).toContain(`update=${id} outcome=rolled-back`);
  expect(f.received[0]!.text).toContain("reason=restart-failed");
  expect(JSON.stringify(f.received)).not.toContain("/Users/owner");
});

it("falls back to the conversation and warns when the named lead's webhook refuses, and never replays it", async () => {
  const f = await fixture();
  f.refuseWakes();
  await f.operation({
    phase: "rolled-back",
    healthy: false,
    rollbackHealthy: true,
    oldCommit: "b".repeat(40),
    newCommit: "c".repeat(40),
    initiator: { kind: "cli", notifyLead: "duet" },
  });
  const canary = f.canary();
  canary.start();
  await expect.poll(() => f.alerts.length).toBe(1);
  expect(f.alerts[0]).toContain("A lead couldn't be told how this update ended.");
  expect(f.warnings).toEqual([{ lead: "duet", outcome: "refused" }]);
  await canary.close();
  const next = f.canary();
  next.start();
  await vi.waitFor(() => expect(f.received).toHaveLength(1));
  await next.close();
  expect(f.alerts).toHaveLength(1);
});
