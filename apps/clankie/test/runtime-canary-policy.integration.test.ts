import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { mintOperatorToken } from "@clankie/credential-broker";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { runUpdateCommand } from "../../tui/src/command/update.ts";
import { readRuntimeUpdate, writeRuntimeUpdate } from "../../tui/bin/runtime-update.ts";
import { writePrivateJson } from "../../tui/bin/update-files.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { DeployHolds } from "../src/deploy-holds.ts";
import { RuntimeCanary, type RuntimeCanaryPolicy } from "../src/runtime-canary.ts";
import { createRuntimeHealthSampler } from "../src/runtime-health-sample.ts";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Actual listener, bearer admission, CLI fetch and private operation storage. No scheduler or updater. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-canary-policy-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const updates = join(root, "updates");
  await mkdir(updates, { mode: 0o700 });
  const runtime = { root, commit: "b".repeat(40), instanceId: randomUUID(), pid: process.pid };
  const token = mintOperatorToken();
  const authenticate = createBearerAuthenticator(token, { operatorId: "canary-policy-owner" });
  let authorityCurrent = true;
  let admissions = 0;
  let revokeOnAdmission: number | undefined;
  const holds = new DeployHolds(join(root, "integration"));
  const requests: Array<{ method: string; path: string }> = [];
  const app = new Hono();
  app.use("*", async (context, next) => {
    requests.push({ method: context.req.method, path: context.req.path });
    await next();
  });
  app.get("/health", (context) => context.json({ ok: true, service: "clankie", runtime }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Policy fixture listener has no address");
  const host = `http://127.0.0.1:${address.port}`;
  const sample = createRuntimeHealthSampler({ healthUrl: `${host}/health` });
  const createCanary = () => {
    const canary = new RuntimeCanary({ updatesDirectory: updates, runtime, holds, sample });
    cleanup.push(() => canary.close());
    return canary;
  };
  const canary = createCanary();
  app.route(
    "/",
    createRuntimeUpdateRoutes({
      canary,
      holds,
      authorize: async (request) => {
        if (!(await authenticate(request))) return undefined;
        return {
          current: () => {
            const admitted = authorityCurrent;
            admissions++;
            if (revokeOnAdmission === admissions) {
              revokeOnAdmission = undefined;
              // Revoke immediately after admission, before the genuine async
              // lock/owner-file/fsync path can publish the policy.
              queueMicrotask(() => {
                authorityCurrent = false;
              });
            }
            return admitted;
          },
          guard: async () => {
            if (!authorityCurrent || !(await authenticate(request)))
              throw Error("Operator authentication required");
          },
        };
      },
    }),
  );
  const cli = (args: string[], credential = token) =>
    runUpdateCommand(args, {
      host,
      env: { CLANKIE_OPERATOR_TOKEN: credential },
    });
  const http = (method: "GET" | "PUT", body?: unknown, credential: string | null = token) =>
    fetch(`${host}/v1/runtime-update/canary`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const policyFile = join(updates, "canary-policy.json");
  const persisted = () => readFile(policyFile, "utf8");
  return {
    root,
    updates,
    runtime,
    canary,
    createCanary,
    holds,
    requests,
    cli,
    http,
    policyFile,
    persisted,
    revokeAfterAdmission: (attempt: number) => {
      revokeOnAdmission = admissions + attempt;
    },
  };
}

it("reads defaults through HTTP and CLI, then durably retains every unmentioned nondefault field on partial PUT", async () => {
  const f = await fixture();
  const defaults: RuntimeCanaryPolicy = {
    windowMs: 300_000,
    sampleIntervalMs: 10_000,
    cpuPercent: 10,
    healthLatencyMs: 250,
  };
  const response = await f.http("GET");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ policy: defaults, canary: null, cpu: null });
  expect(await f.cli(["canary"])).toEqual({ policy: defaults, canary: null, cpu: null });
  await expect(stat(f.policyFile)).rejects.toMatchObject({ code: "ENOENT" });

  const configured: RuntimeCanaryPolicy = {
    windowMs: 600_000,
    sampleIntervalMs: 20_000,
    cpuPercent: 8,
    healthLatencyMs: 125,
  };
  expect(
    await f.cli([
      "canary",
      "--window-seconds",
      "600",
      "--sample-seconds",
      "20",
      "--cpu-percent",
      "8",
      "--health-ms",
      "125",
    ]),
  ).toEqual({ policy: configured, appliesTo: "next_canary" });
  const partial = await f.http("PUT", { cpuPercent: 7 });
  expect(partial.status).toBe(200);
  expect(partial.headers.get("cache-control")).toBe("no-store");
  const updated = { ...configured, cpuPercent: 7 };
  expect(await partial.json()).toEqual({ policy: updated, appliesTo: "next_canary" });
  expect(JSON.parse(await f.persisted())).toEqual(updated);
  expect((await stat(f.policyFile)).mode & 0o077).toBe(0);
  expect(f.createCanary().policy()).toEqual(updated);
  expect(await f.cli(["canary"])).toEqual({ policy: updated, canary: null, cpu: null });
  expect(f.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
});

it("refuses unsafe related fields, unknown HTTP fields and unauthenticated reads and writes without changing stored policy", async () => {
  const f = await fixture();
  await f.cli([
    "canary",
    "--window-seconds",
    "4",
    "--sample-seconds",
    "1",
    "--cpu-percent",
    "9",
    "--health-ms",
    "200",
  ]);
  const before = await f.persisted();
  const rejected = [
    { windowMs: 1000, sampleIntervalMs: 1000 },
    { windowMs: 3_600_001, sampleIntervalMs: 1000 },
    { cpuPercent: 0 },
    { sampleIntervalMs: 1000.5 },
    { healthLatencyMs: null },
    { unknownFlag: 8 },
  ];
  for (const input of rejected) {
    const response = await f.http("PUT", input);
    expect(response.status, JSON.stringify(input)).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_canary_policy" });
    expect(await f.persisted()).toBe(before);
  }
  for (const credential of [null, mintOperatorToken()]) {
    const read = await f.http("GET", undefined, credential);
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: "operator_required" });
    const write = await f.http("PUT", { cpuPercent: 2 }, credential);
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "operator_required" });
    expect(await f.persisted()).toBe(before);
  }
  await expect(f.cli(["canary"], mintOperatorToken())).rejects.toThrow("(403)");
  await expect(f.cli(["canary", "--cpu-percent", "2"], mintOperatorToken())).rejects.toThrow("(403)");
  await expect(f.cli(["canary", "--window-seconds", "1", "--sample-seconds", "1"])).rejects.toThrow("(400)");
  expect(await f.persisted()).toBe(before);
  expect(f.createCanary().policy()).toEqual(JSON.parse(before));
});

it.each([
  { phase: "lock acquisition", admission: 1 },
  { phase: "durable publication", admission: 2 },
])(
  "refuses policy authority revoked across %s awaits, preserving the original policy",
  async ({ admission }) => {
    const f = await fixture();
    await f.cli(["canary", "--cpu-percent", "9"]);
    const before = await f.persisted();
    f.revokeAfterAdmission(admission);
    const response = await f.http("PUT", { cpuPercent: 2 });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "operator_revoked" });
    expect(await f.persisted()).toBe(before);
    expect(f.createCanary().policy()).toEqual(JSON.parse(before));
    expect(
      (await readdir(f.updates)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
    ).toEqual([]);
  },
);

it("applies policy changes to the next canary while retaining a pending observation's armed policy and deploy hold", async () => {
  const f = await fixture();
  const previous: RuntimeCanaryPolicy = {
    windowMs: 10_000,
    sampleIntervalMs: 2000,
    cpuPercent: 8,
    healthLatencyMs: 200,
  };
  await f.cli([
    "canary",
    "--window-seconds",
    "10",
    "--sample-seconds",
    "2",
    "--cpu-percent",
    "8",
    "--health-ms",
    "200",
  ]);
  const id = randomUUID();
  const directory = join(f.updates, id);
  await mkdir(directory, { mode: 0o700 });
  writePrivateJson(join(f.updates, "latest.json"), { id });
  writeRuntimeUpdate(directory, {
    id,
    ref: "main",
    oldCommit: "a".repeat(40),
    newCommit: f.runtime.commit,
    phase: "healthy",
    healthy: true,
    canary: { state: "pending" },
    updatedAt: new Date().toISOString(),
  });
  await f.canary.recover();
  const pending = await readFile(join(directory, "result.json"), "utf8");
  const armed = await readFile(join(directory, "canary-policy.json"), "utf8");
  expect(f.canary.status()).toMatchObject({ state: "pending", policy: previous, samples: 0 });
  expect((await f.holds.list()).map((hold) => hold.id)).toEqual([id]);

  const next = { ...previous, cpuPercent: 5 };
  expect(await f.cli(["canary", "--cpu-percent", "5"])).toEqual({ policy: next, appliesTo: "next_canary" });
  expect(await f.cli(["canary"])).toMatchObject({
    policy: next,
    canary: { state: "pending", policy: previous, samples: 0 },
  });
  expect(await readFile(join(directory, "result.json"), "utf8")).toBe(pending);
  expect(await readFile(join(directory, "canary-policy.json"), "utf8")).toBe(armed);
  const reopened = f.createCanary();
  expect(reopened.policy()).toEqual(next);
  await reopened.recover();
  expect(readRuntimeUpdate(directory).canary).toMatchObject({
    state: "pending",
    policy: previous,
    samples: 0,
  });
  expect((await f.holds.list()).map((hold) => hold.id)).toEqual([id]);
  await expect(f.holds.landing("next-update", [], async () => "admitted")).rejects.toThrow("Deploy held");
});

it("rejects duplicate or invalid canary CLI options before sending HTTP or changing durable settings", async () => {
  const f = await fixture();
  await f.cli(["canary", "--cpu-percent", "7"]);
  const before = await f.persisted();
  const requests = f.requests.length;
  for (const args of [
    ["canary", "--cpu-percent", "8", "--cpu-percent", "9"],
    ["canary", "--window-seconds", "4", "--window-seconds", "8"],
    ["canary", "--unknown", "1"],
    ["canary", "--cpu-percent", "NaN"],
    ["canary", "--cpu-percent", "Infinity"],
    ["canary", "--cpu-percent", "0"],
    ["canary", "--cpu-percent", "-1"],
    ["canary", "--health-ms"],
  ]) {
    await expect(f.cli(args), args.join(" ")).rejects.toThrow("Usage");
    expect(await f.persisted()).toBe(before);
  }
  expect(f.requests).toHaveLength(requests);
});
