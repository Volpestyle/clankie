import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mintOperatorToken } from "@clankie/credential-broker";
import { MachineWorkerAccountsSchema } from "@clankie/protocol/worker-accounts";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkerAccountHoldsRoutes } from "../src/worker-account-holds-routes.ts";
import { chooseWorkerHarness, createWorkerAccountsReader } from "../src/captain/harness-accounts.ts";
import { createPiWorkerStatusReader, localPiWorkerModelStatus } from "../src/captain/pi-worker-account.ts";
import { runAccountsCommand } from "../../tui/src/command/accounts.ts";

let root: string;
let previous: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clankie-pi-worker-account-"));
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
        reason: "Native Pi control is not enabled",
      },
    ]);
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

// This acceptance slice uses the actual pinned Pi installed on the worker machine.
// CI without that native prerequisite still runs the API/auth refusal boundaries above.
const nativePiInstalled = (process.env.PATH ?? "")
  .split(delimiter)
  .some((path) => existsSync(join(path, "pi")));
it.skipIf(!nativePiInstalled || !["darwin", "linux"].includes(process.platform))(
  "only makes verified native Pi eligible and excludes held/model/account scopes",
  async () => {
    const settings = new SettingsStore(join(root, "settings.json"));
    const reader = createWorkerAccountsReader({
      settings: () => settings.load(),
      fleet: async () => undefined,
      piStatus: createPiWorkerStatusReader({ enabled: () => true, cwd: root }),
    });
    const report = await reader(undefined, ["pi"]);
    expect(MachineWorkerAccountsSchema.parse(report)).toEqual(report);
    expect(report.accounts).toEqual([
      {
        harness: "pi",
        label: "default",
        home: join(root, "pi"),
        signedIn: true,
        usable: true,
        headroom: null,
        models: ["openai/gpt-4o"],
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
  },
);

it.skipIf(!nativePiInstalled || !["darwin", "linux"].includes(process.platform))(
  "exposes expired native OAuth through the owner API and CLI without refresh or auto admission",
  async () => {
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
  },
);
