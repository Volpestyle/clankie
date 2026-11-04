import { fileURLToPath } from "node:url";
import { TAKE_CONTROL_GRANTS, SUPERVISE_GRANTS } from "@clankie/protocol";
import { startFixtureServer } from "./owner-settings-surface-fixture.ts";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mintOperatorToken } from "@clankie/credential-broker";
import { MachineWorkerAccountsSchema } from "@clankie/protocol/worker-accounts";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkerAccountHoldsRoutes } from "../src/worker-account-holds-routes.ts";
import { chooseWorkerHarness, createWorkerAccountsReader } from "../src/captain/harness-accounts.ts";
import {
  createPiWorkerStatusReader,
  localPiWorkerModelStatus,
  PI_NOT_ENABLED,
} from "../src/captain/pi-worker-account.ts";
import { runAccountsCommand } from "../../tui/src/command/accounts.ts";
import { supportedPiUnavailable } from "./fixtures/supported-pi.ts";

let root: string;
let previous: string | undefined;
let previousPath: string | undefined;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "clankie-pi-worker-account-")));
  previousPath = process.env.PATH;
  await installPiFixture("1.0.0");
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi");
  await mkdir(join(root, "pi"));
  await writeFile(
    join(root, "pi", "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }),
  );
  await writeFile(
    join(root, "pi", "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "fixture-only-key" } }),
  );
});
afterEach(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  process.env.PATH = previousPath;
  await rm(root, { recursive: true, force: true });
});

it("reads native Pi's real selected model/auth without rewriting credentials and refuses unknown/expired models", async () => {
  const authPath = join(root, "pi", "auth.json");
  const before = await readFile(authPath, "utf8");
  expect(await localPiWorkerModelStatus(root)).toEqual({ model: "openai/gpt-4o" });
  expect(await readFile(authPath, "utf8")).toBe(before);
  await writeFile(
    join(root, "pi", "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "unregistered-fixture-model" }),
  );
  expect(await localPiWorkerModelStatus(root)).toEqual({
    reason: "The native Pi profile’s selected model is unavailable",
  });
  await writeFile(
    join(root, "pi", "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }),
  );
  const expired = JSON.stringify({
    openai: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1 },
  });
  await writeFile(authPath, expired);
  expect(await localPiWorkerModelStatus(root)).toEqual({
    reason: "The native Pi profile’s OAuth credential has expired; refresh it in Pi before hiring",
  });
  expect(await readFile(authPath, "utf8")).toBe(expired);
});

it("exposes the same disabled Pi status and revision-fenced owner hold through API, CLI and the local account reader", async () => {
  const settings = new SettingsStore(join(root, "settings.json"));
  const reader = createWorkerAccountsReader({
    settings: () => settings.load(),
    fleet: async () => undefined,
    piStatus: createPiWorkerStatusReader({ enabled: () => false, cwd: root }),
  });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    workerAccounts: () => reader(undefined, ["pi"]),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
  });
  try {
    const response = await app.app.request("/v1/worker-accounts", {
      headers: { authorization: "Bearer fixture-owner" },
    });
    const initial = MachineWorkerAccountsSchema.parse(await response.json());
    expect(initial.accounts).toEqual([
      {
        harness: "pi",
        label: "default",
        home: join(root, "pi"),
        signedIn: null,
        headroom: null,
        usable: false,
        reason: PI_NOT_ENABLED,
        pi: { state: "not_enabled" },
      },
    ]);
    expect(initial.accounts[0]?.pi?.state).toBe("not_enabled");
    expect(chooseWorkerHarness("local", await reader(undefined, ["pi"]))).toHaveProperty("refused");
    const token = mintOperatorToken();
    const routes = createWorkerAccountHoldsRoutes(
      async (request) =>
        request.headers.get("authorization") === `Bearer ${token}` ? true : "authentication_required",
      settings,
    );
    const client = {
      env: { CLANKIE_OPERATOR_TOKEN: token },
      host: "http://fixture.test",
      fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
        routes.fetch(new Request(String(url), init))) as typeof fetch,
    };
    const held = await runAccountsCommand(
      ["hold", "pi", "default", "--reason", "saved for another job"],
      client,
    );
    expect(held).toMatchObject({
      holds: [{ machine: "local", harness: "pi", label: "default", reason: "saved for another job" }],
    });
    expect((await reader(undefined, ["pi"])).accounts[0]).toMatchObject({
      held: { reason: "saved for another job" },
    });
    await runAccountsCommand(["release", "pi", "default"], client);
    expect((await reader(undefined, ["pi"])).accounts[0]?.held).toBeUndefined();
  } finally {
    await app.close();
  }
});

// This acceptance slice uses the actual Pi installed on the worker machine. It
// runs only when native control's own check accepts that Pi, and otherwise skips
// naming what it found (VUH-2414); the API/auth refusal boundaries above still run.
const nativePi = await supportedPiUnavailable();
it("only makes verified native Pi eligible and excludes held/model/account scopes", async ({ skip }) => {
  skip(nativePi !== undefined, nativePi);
  const settings = new SettingsStore(join(root, "settings.json"));
  const reader = createWorkerAccountsReader({
    settings: () => settings.load(),
    fleet: async () => undefined,
    piStatus: createPiWorkerStatusReader({ enabled: () => true, cwd: root }),
  });
  const report = await reader(undefined, ["pi"]);
  expect(MachineWorkerAccountsSchema.parse(report).accounts).toEqual(report.accounts);
  expect(report.accounts).toEqual([
    {
      harness: "pi",
      label: "default",
      home: join(root, "pi"),
      signedIn: true,
      usable: true,
      headroom: null,
      models: ["openai/gpt-4o"],
      pi: { state: "ready" },
    },
  ]);
  expect(chooseWorkerHarness("local", report)).toMatchObject({ harness: "pi" });
  expect(chooseWorkerHarness("local", report, ["claude", "codex"])).toHaveProperty("refused");
  expect(chooseWorkerHarness("local", report, ["pi"], "another-profile")).toHaveProperty("refused");
  await settings.update((current) => ({
    ...current,
    workerAccountHolds: [{ machine: "local", harness: "pi", label: "default" }],
  }));
  expect(chooseWorkerHarness("local", await reader(undefined, ["pi"]))).toHaveProperty("refused");
  const unavailable = await createPiWorkerStatusReader({
    enabled: () => true,
    cwd: root,
    seatModel: async () => undefined,
  })();
  expect(unavailable).toMatchObject({ usable: false, signedIn: false });
  const bareModel = await createPiWorkerStatusReader({
    enabled: () => true,
    cwd: root,
    seatModel: async () => ({ model: "openai/gpt-4o" }),
  })();
  expect(bareModel).toMatchObject({ usable: false, signedIn: false });
  const configured = await createPiWorkerStatusReader({
    enabled: () => true,
    cwd: root,
    seatModel: async () => ({
      model: "clankie/default",
      provider: {
        id: "clankie",
        config: {
          baseUrl: "http://127.0.0.1:1234/v1",
          apiKey: "local",
          models: [{ id: "default" }, { id: "routine" }, { id: "escalation" }, { id: "invalid model" }],
        },
      },
    }),
  })();
  expect(configured).toMatchObject({
    usable: true,
    models: ["clankie/default", "clankie/routine", "clankie/escalation"],
  });
  expect(configured.models).not.toContain("clankie/invalid model");
  const customer = await createPiWorkerStatusReader({
    enabled: () => true,
    cwd: root,
    seatModel: async () => ({
      model: "clankie-customer/qwen/model-v1",
      provider: {
        id: "clankie-customer",
        config: {
          baseUrl: "http://127.0.0.1:1234/v1",
          apiKey: "local",
          models: [{ id: "qwen/model-v1" }, { id: "qwen/model:v2" }, { id: "invalid model" }],
        },
      },
    }),
  })();
  expect(customer).toMatchObject({
    usable: true,
    models: ["clankie-customer/qwen/model-v1", "clankie-customer/qwen/model:v2"],
  });
  expect(customer.models).not.toContain("clankie-customer/invalid model");
  expect(JSON.stringify(configured)).not.toContain("127.0.0.1");
  expect(JSON.stringify(report)).not.toContain("fixture-only-key");
});

it("exposes expired native OAuth through the owner API and CLI without refresh or auto admission", async ({
  skip,
}) => {
  skip(nativePi !== undefined, nativePi);
  const authPath = join(root, "pi", "auth.json");
  const expired = JSON.stringify({
    openai: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1 },
  });
  await writeFile(authPath, expired);
  const settings = new SettingsStore(join(root, "settings.json"));
  const reader = createWorkerAccountsReader({
    settings: () => settings.load(),
    fleet: async () => undefined,
    piStatus: createPiWorkerStatusReader({ enabled: () => true, cwd: root }),
  });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    workerAccounts: () => reader(undefined, ["pi"]),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
  });
  try {
    const request = async (path: string) =>
      (await (
        await app.app.request(path, { headers: { authorization: "Bearer fixture-owner" } })
      ).json()) as Record<string, unknown>;
    const result = MachineWorkerAccountsSchema.parse(await runAccountsCommand(["workers"], { request }));
    expect(result.accounts[0]).toMatchObject({
      harness: "pi",
      usable: false,
      signedIn: false,
      reason: "The native Pi profile’s OAuth credential has expired; refresh it in Pi before hiring",
    });
    const producer = await reader(undefined, ["pi"]);
    expect(result.accounts).toEqual(producer.accounts);
    expect(chooseWorkerHarness("local", producer, ["pi"])).toHaveProperty("refused");
    expect(await readFile(authPath, "utf8")).toBe(expired);
    expect(JSON.stringify(result)).not.toContain("fixture-access");
    expect(JSON.stringify(result)).not.toContain("fixture-refresh");
  } finally {
    await app.close();
  }
});

/** Stub installation on PATH; its SDK is the real pinned dependency, probed offline. */
async function installPiFixture(version: string) {
  const packageRoot = join(root, "installed", version);
  const bundle = join(packageRoot, "dist/bundle");
  const bin = join(packageRoot, "bin");
  await mkdir(join(bundle, "chunks"), { recursive: true });
  await mkdir(bin);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      type: "module",
      name: "@earendil-works/pi-coding-agent",
      version,
    }),
  );
  await writeFile(join(bundle, "cli.js"), 'import "./cli-runtime.js";');
  await chmod(join(bundle, "cli.js"), 0o755);
  await writeFile(join(bundle, "cli-runtime.js"), 'import "./chunks/core.js";');
  await writeFile(join(bundle, "chunks/core.js"), "export {};");
  await symlink(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    join(packageRoot, "dist/index.js"),
  );
  await symlink(join(bundle, "cli.js"), join(bin, "pi"));
  await symlink(process.execPath, join(bin, "node"));
  process.env.PATH = bin;
}

it("serves all four Pi states over real HTTP and persists owner/Take Control enablement through the CLI", async () => {
  const settings = new SettingsStore(join(root, "settings.json"));
  const reader = createWorkerAccountsReader({
    settings: () => settings.load(),
    fleet: async () => undefined,
    piStatus: createPiWorkerStatusReader({
      cwd: root,
      enabled: async () => (await settings.load()).piNativeEnabled ?? false,
    }),
  });
  const token = mintOperatorToken();
  const app = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    deviceSessionKey: new Uint8Array(32).fill(7),
    workerAccounts: () => reader(undefined, ["pi"]),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "owner" } : undefined,
  });
  const server = await startFixtureServer(app.app.fetch);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const request = (path: string, body?: unknown, auth: Record<string, string> = headers) =>
    fetch(`${server.host}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: auth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const readPi = async () =>
    MachineWorkerAccountsSchema.parse(await (await request("/v1/worker-accounts")).json()).accounts[0]!;
  const path = "/v1/worker-accounts/pi";
  try {
    process.env.PATH = join(root, "empty-path");
    expect(await readPi()).toMatchObject({
      usable: false,
      pi: { state: "not_installed", installCommand: "npm install -g @earendil-works/pi-coding-agent" },
    });
    await installPiFixture("0.86.2");
    expect(await readPi()).toMatchObject({
      usable: false,
      pi: { state: "too_old", installCommand: "npm install -g @earendil-works/pi-coding-agent" },
    });
    process.env.PATH = join(root, "installed/1.0.0/bin");
    expect(await readPi()).toMatchObject({ usable: false, pi: { state: "not_enabled" } });
    const initial = await (await request(path)).json();
    expect(
      (
        await request(
          path,
          { enabled: true, expectedRevision: initial.revision },
          { "content-type": "application/json" },
        )
      ).status,
    ).toBe(401);
    expect((await request(path, { enabled: "yes", expectedRevision: initial.revision })).status).toBe(400);
    const client = { env: { CLANKIE_OPERATOR_TOKEN: token }, host: server.host };
    await runAccountsCommand(["pi", "enable"], client);
    expect((await new SettingsStore(settings.path).load()).piNativeEnabled).toBe(true);
    expect(await readPi()).toMatchObject({ usable: true, pi: { state: "ready" }, models: ["openai/gpt-4o"] });
    expect((await request(path, { enabled: false, expectedRevision: initial.revision })).status).toBe(409);
    await runAccountsCommand(["pi", "disable"], client);
    expect(await readPi()).toMatchObject({ usable: false, pi: { state: "not_enabled" } });

    const pair = async (grants: typeof TAKE_CONTROL_GRANTS) => {
      const offer = await (await request("/v1/pairing/offer", {})).json();
      const redeemed = await (
        await request("/v1/pairing/redeem", {
          offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
          device: { name: "Fixture phone", platform: "ios" },
        })
      ).json();
      const completed = await (
        await request("/v1/pairing/complete", {
          completionToken: redeemed.completionToken,
          acceptedGrants: grants,
        })
      ).json();
      return { authorization: `Bearer ${completed.deviceToken}`, "content-type": "application/json" };
    };
    const supervise = await pair(SUPERVISE_GRANTS);
    const current = await (await request(path)).json();
    expect(
      (await request(path, { enabled: true, expectedRevision: current.revision }, supervise)).status,
    ).toBe(403);
    const control = await pair(TAKE_CONTROL_GRANTS);
    expect((await request(path, { enabled: true, expectedRevision: current.revision }, control)).status).toBe(
      200,
    );
    expect(await readPi()).toMatchObject({ usable: true, pi: { state: "ready" } });
    await writeFile(join(root, "pi", "auth.json"), "{}");
    expect(await readPi()).toMatchObject({ usable: false, signedIn: false, pi: { state: "ready" } });
  } finally {
    await server.close();
    await app.close();
  }
}, 60_000);
