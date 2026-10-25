import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileCredentialStore } from "@clankie/credential-broker";
import type { Api } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { BrokerCredentialStore, createRejectedCredentialRefresh } from "../src/captain/model.ts";

// 2026-10-07: openai-codex rejected a stored OAuth token ("Your authentication
// token has expired") ten days before its stored expiry, and Pi refreshes only
// once that expiry passes. Real Pi runtime, real file credential broker and a
// real HTTP token endpoint standing in for the provider's.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEN_DAYS_MS = 10 * 24 * 60 * 60_000;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-credential-refresh-"));
  const tokenRequests: string[] = [];
  const endpoint = { delayMs: 0 };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", async () => {
      const refresh = (JSON.parse(body) as { refresh: string }).refresh;
      tokenRequests.push(refresh);
      await new Promise((resolve) => setTimeout(resolve, endpoint.delayMs));
      response.setHeader("content-type", "application/json");
      if (refresh === "revoked") {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.end(
        JSON.stringify({ access: `${refresh}-access`, refresh: `${refresh}-next`, expiresIn: 3_600 }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing token endpoint");
  const tokenUrl = `http://127.0.0.1:${String(address.port)}/token`;
  const broker = new FileCredentialStore(join(root, "credentials.json"));
  const credentials = new BrokerCredentialStore(broker);
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("token-provider", {
    api: "openai-completions" as Api,
    baseUrl: "http://127.0.0.1:9/v1",
    oauth: {
      name: "Token provider",
      login: async () => {
        throw new Error("Interactive login is not part of this test");
      },
      refreshToken: async (current, signal) => {
        const response = await fetch(tokenUrl, {
          method: "POST",
          body: JSON.stringify({ refresh: current.refresh }),
          signal,
        });
        if (!response.ok) throw new Error(`token endpoint answered ${String(response.status)}`);
        const token = (await response.json()) as { access: string; refresh: string; expiresIn: number };
        return {
          access: token.access,
          refresh: token.refresh,
          expires: Date.now() + token.expiresIn * 1_000,
        };
      },
      getApiKey: (current) => current.access,
    },
    models: [
      {
        id: "token-model",
        name: "token-model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      },
    ],
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    tokenUrl,
    endpoint,
    broker,
    credentials,
    runtime,
    tokenRequests,
    refresh: createRejectedCredentialRefresh(credentials, runtime),
  };
}

it("refreshes a provider-rejected OAuth token once, though its stored expiry is days away", async () => {
  const f = await fixture();
  const expires = Date.now() + TEN_DAYS_MS;
  await f.broker.set("token-provider", { type: "oauth", access: "rejected", refresh: "r0", expires });
  // Pi alone keeps using the stored token until its expiry.
  expect((await f.runtime.getAuth("token-provider"))?.auth.apiKey).toBe("rejected");
  expect(f.tokenRequests).toEqual([]);

  // Two lanes see the same rejection at once: one refresh serves both.
  const outcomes = await Promise.all([f.refresh("token-provider"), f.refresh("token-provider")]);
  expect(outcomes).toEqual(["refreshed", "refreshed"]);
  expect(f.tokenRequests).toEqual(["r0"]);
  expect(await f.broker.get("token-provider")).toMatchObject({
    type: "oauth",
    access: "r0-access",
    refresh: "r0-next",
  });
  expect((await f.runtime.getAuth("token-provider"))?.auth.apiKey).toBe("r0-access");
});

it("reports a failed refresh, so the owner is asked to reconnect", async () => {
  const f = await fixture();
  await f.broker.set("token-provider", {
    type: "oauth",
    access: "rejected",
    refresh: "revoked",
    expires: Date.now() + TEN_DAYS_MS,
  });
  expect(await f.refresh("token-provider")).toBe("failed");
  expect(f.tokenRequests).toEqual(["revoked"]);
});

it("has nothing to refresh for an API key", async () => {
  const f = await fixture();
  await f.broker.set("token-provider", { type: "api", key: "sk-rejected" });
  expect(await f.refresh("token-provider")).toBe("not_oauth");
  expect(f.tokenRequests).toEqual([]);
  expect(await f.broker.get("token-provider")).toEqual({ type: "api", key: "sk-rejected" });
});

it("two service processes refreshing one expired token send its refresh token once", async () => {
  const f = await fixture();
  await f.broker.set("token-provider", { type: "oauth", access: "stale", refresh: "r0", expires: 0 });
  // A slow provider keeps the first refresh in flight while the second process asks.
  f.endpoint.delayMs = 500;
  const children = [0, 1].map(() => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        fileURLToPath(new URL("./fixtures/model-refresh-process.ts", import.meta.url)),
        JSON.stringify({ path: join(f.root, "credentials.json"), tokenUrl: f.tokenUrl }),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += String(chunk)));
    const ready = new Promise<void>((resolve) =>
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.startsWith("ready\n")) resolve();
      }),
    );
    const done = new Promise<string>((resolve, reject) =>
      child.on("close", (code) =>
        code === 0
          ? resolve(output.slice("ready\n".length).trim())
          : reject(new Error(`Refresh process failed ${String(code)}: ${errors}`)),
      ),
    );
    cleanups.push(() => void child.kill());
    return { child, ready, done };
  });
  await Promise.all(children.map((c) => c.ready));
  for (const { child } of children) child.stdin.end("go\n");
  expect(await Promise.all(children.map((c) => c.done))).toEqual(["r0-access", "r0-access"]);
  expect(f.tokenRequests).toEqual(["r0"]);
  expect(await f.broker.get("token-provider")).toMatchObject({
    type: "oauth",
    access: "r0-access",
    refresh: "r0-next",
  });
}, 30_000);
