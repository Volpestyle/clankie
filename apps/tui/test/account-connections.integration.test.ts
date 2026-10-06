import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore, googleIdentityEpochKey, resolveGoogleBearer } from "@clankie/credential-broker";
import { runAccountsCommand } from "../src/command/accounts.ts";
import { SettingsStore } from "@clankie/settings";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("keeps the selected Google capability and stdin-only code across authenticated CLI HTTP requests", async () => {
  const seen: { path: string; body: unknown; authorization: string | undefined }[] = [];
  const state = "s".repeat(32);
  const marker = "fixture-google-code-not-output";
  let unsafe = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body);
    seen.push({ path: request.url ?? "", body: input, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        unsafe
          ? { ok: true, access_token: marker }
          : {
              ok: true,
              connection: {
                provider: input.provider,
                status: "connected",
                scopes: ["openid", "email"],
                readOnly: input.provider !== "google-drive",
              },
            },
      ),
    );
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const env = {
    CLANKIE_OPERATOR_TOKEN: "fixture-google-owner",
    CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
  };
  for (const provider of ["google-gmail", "google-calendar", "google-drive"]) {
    const run = (input: string) =>
      runAccountsCommand(["complete", provider, "--json-stdin"], { env, stdin: Readable.from([input]) });
    const picked = provider === "google-drive" ? { pickedFileIds: ["fixture-picked_file"] } : {};
    const result = await run(JSON.stringify({ state, code: marker, ...picked }));
    expect(result).toMatchObject({
      ok: true,
      connection: { provider, readOnly: provider !== "google-drive" },
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(await runAccountsCommand(["check", provider], { env })).toMatchObject({
      ok: true,
      connection: { provider },
    });
    for (const input of [
      marker,
      JSON.stringify({ state, code: "" }),
      JSON.stringify({ state, code: marker, provider: "google-drive" }),
      JSON.stringify({ state, code: marker, pickedFileIds: ["one", "one"] }),
      JSON.stringify({ state, code: marker, pickedFileIds: [] }),
    ])
      await expect(run(input)).rejects.toThrow("Invalid Google authorization response");
  }
  expect(seen.map((request) => request.path)).toEqual(
    Array(3).fill(["/v1/accounts/google/complete", "/v1/accounts/google/check"]).flat(),
  );
  expect(seen[0]?.body).toEqual({ provider: "google-gmail", state, code: marker });
  expect(seen[4]?.body).toEqual({
    provider: "google-drive",
    state,
    code: marker,
    pickedFileIds: ["fixture-picked_file"],
  });
  expect(seen.every((request) => request.authorization === "Bearer fixture-google-owner")).toBe(true);
  unsafe = true;
  await expect(
    runAccountsCommand(["complete", "google-gmail", "--json-stdin"], {
      env,
      stdin: Readable.from([JSON.stringify({ state, code: marker })]),
    }),
  ).rejects.toThrow("Account connection unavailable");
});

it("stores a Google developer secret only in the local broker, separately from public OAuth configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "google-oauth-cli-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const credentials = new FileCredentialStore(join(directory, "broker.json"));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const clientId = "fixture.apps.googleusercontent.com";
  const secret = "fixture-google-developer-secret";
  const env = { CLANKIE_OPERATOR_TOKEN: "fixture-owner" };
  expect(
    await runAccountsCommand(
      [
        "apps",
        "set",
        "--google-client-id",
        clientId,
        "--google-redirect-uri",
        "http://127.0.0.1:4310/account/connections/google/callback",
      ],
      { env, settings },
    ),
  ).toMatchObject({
    oauthApps: {
      google: { clientId, redirectUri: "http://127.0.0.1:4310/account/connections/google/callback" },
    },
  });
  const result = await runAccountsCommand(
    ["apps", "google-secret", "--client-id", clientId, "--secret-stdin"],
    { env, credentials, stdin: Readable.from([secret]) },
  );
  expect(await credentials.get("google-oauth-app")).toEqual({
    type: "api",
    key: secret,
    metadata: { clientId },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(await settings.load())).not.toContain(secret);
  expect(
    await runAccountsCommand(["apps", "clear", "--google-client-id", "--google-redirect-uri"], {
      env,
      settings,
    }),
  ).toMatchObject({ oauthApps: { google: {} } });
  await expect(
    runAccountsCommand(["apps", "google-secret", "--client-id", clientId, "--secret-stdin"], {
      request: async () => {
        throw new Error("Must not dispatch");
      },
      credentials,
      stdin: Readable.from([secret]),
    }),
  ).rejects.toThrow("OAuth application configuration is managed by the hosted service");
});

it("refuses hosted Google developer secret provisioning before consuming stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-google-secret-refused-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const bootstrap = join(directory, "bootstrap.json");
  await writeFile(bootstrap, JSON.stringify({ accountId: "fixture-account", hostId: "fixture-host" }));
  const credentials = new FileCredentialStore(join(directory, "broker.json"));
  let consumed = 0;
  const stdin = new Readable({
    read() {
      consumed++;
      this.push("fixture-secret");
      this.push(null);
    },
  });
  await expect(
    runAccountsCommand(
      ["apps", "google-secret", "--client-id", "fixture.apps.googleusercontent.com", "--secret-stdin"],
      {
        env: { CLANKIE_HOSTED_BOOTSTRAP_FILE: bootstrap, CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
        credentials,
        stdin,
      },
    ),
  ).rejects.toThrow("owner-run self-hosted OAuth app");
  expect(consumed).toBe(0);
  expect(await credentials.get("google-oauth-app")).toBeUndefined();
  expect(await readdir(directory)).toEqual(["bootstrap.json"]);
  stdin.destroy();
});

it("preserves durable Google disable barriers when replacing a developer secret after a partial disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "google-secret-disable-barrier-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const credentials = new FileCredentialStore(join(directory, "broker.json"));
  const clientId = "fixture.apps.googleusercontent.com";
  const identity = { clientId, subject: "fixture-google-subject" };
  const barriers = {
    clientId,
    googleGeneration: "disconnected-app-generation",
    [googleIdentityEpochKey(identity)]: "revoked-identity-epoch",
  };
  await credentials.set("google-oauth-app", { type: "api", key: "fixture-old-secret", metadata: barriers });
  // This connected sibling survived an interrupted multi-entry broker write.
  // The app's durable identity barrier must continue to deny its old token.
  await credentials.set("google-gmail", {
    type: "oauth",
    googleAuth: "user",
    clientId,
    access: "fixture-old-access",
    refresh: "fixture-old-refresh",
    expires: Date.now() + 3_600_000,
    metadata: {
      ...identity,
      email: "fixture@example.test",
      scopes: "openid email https://www.googleapis.com/auth/gmail.readonly",
      connectedAt: new Date().toISOString(),
      status: "connected",
      identityEpoch: "0",
    },
  });
  const result = await runAccountsCommand(
    ["apps", "google-secret", "--client-id", clientId, "--secret-stdin"],
    {
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      credentials,
      stdin: Readable.from(["fixture-new-secret"]),
    },
  );
  expect(result).toMatchObject({ ok: true });
  expect(await credentials.get("google-oauth-app")).toEqual({
    type: "api",
    key: "fixture-new-secret",
    metadata: barriers,
  });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500);
    response.end();
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const origin = `http://127.0.0.1:${address.port}`;
  await expect(
    resolveGoogleBearer({
      store: credentials,
      provider: "google-gmail",
      apps: async () => ({ clientId, redirectUri: `${origin}/account/connections/google/callback` }),
      endpoints: { authorize: origin, token: origin, revoke: origin, jwks: origin },
    }),
  ).rejects.toThrow("Google account disconnected");
  expect(requests).toBe(0);
});

it("hands a stdin-only Linear code to the authenticated HTTP body API and refuses malformed or secret-bearing responses", async () => {
  const seen: { path: string; body: string; authorization: string | undefined }[] = [];
  const state = "s".repeat(24);
  const marker = "fixture-private-code-never-output";
  let unsafe = false;
  const server: Server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    seen.push({ path: request.url ?? "", body, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        unsafe
          ? { ok: true, access_token: marker }
          : {
              ok: true,
              connection: {
                provider: "linear",
                status: "connected",
                actor: "app",
                scopes: ["read", "write"],
              },
            },
      ),
    );
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const env = {
    CLANKIE_OPERATOR_TOKEN: "fixture-owner",
    CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
  };
  const run = (input: string) =>
    runAccountsCommand(["complete", "linear", "--json-stdin"], { env, stdin: Readable.from([input]) });
  const result = await run(JSON.stringify({ state, code: marker }));
  expect(result).toMatchObject({ ok: true, connection: { scopes: ["read", "write"] } });
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(seen).toEqual([
    {
      path: "/v1/accounts/linear/complete",
      body: JSON.stringify({ state, code: marker }),
      authorization: "Bearer fixture-owner",
    },
  ]);
  for (const input of [
    marker,
    JSON.stringify({ state, code: "" }),
    JSON.stringify({ state, code: marker, access_token: marker }),
  ])
    await expect(run(input)).rejects.toThrow("Invalid Linear authorization response");
  expect(seen).toHaveLength(1);
  unsafe = true;
  await expect(run(JSON.stringify({ state, code: marker }))).rejects.toThrow(
    "Account connection unavailable",
  );
});

it("stores the developer GitHub revocation secret only in the body broker, bound to the configured app ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-revoke-cli-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const credentials = new FileCredentialStore(join(directory, "broker.json"));
  const secret = "fixture-developer-secret-never-output";
  const result = await runAccountsCommand(
    ["apps", "github-secret", "--client-id", "fixture-app", "--secret-stdin"],
    {
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      credentials,
      stdin: Readable.from([secret]),
    },
  );
  expect(await credentials.get("github-oauth-app")).toEqual({
    type: "api",
    key: secret,
    metadata: { clientId: "fixture-app" },
  });
  expect(result).toEqual({ ok: true, provider: "github", revocation: "configured" });
  expect(JSON.stringify(result)).not.toContain(secret);
  await expect(
    runAccountsCommand(["apps", "github-secret", "--client-id", "fixture-app", "--secret-stdin"], {
      request: async () => {
        throw new Error("Must not dispatch");
      },
      credentials,
      stdin: Readable.from([secret]),
    }),
  ).rejects.toThrow("OAuth application configuration is managed by the hosted service");
});

it("refuses GitHub app secret provisioning in a hosted body before consuming stdin or accessing the broker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-github-secret-refused-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const bootstrap = join(directory, "bootstrap.json");
  await writeFile(bootstrap, JSON.stringify({ accountId: "fixture-account", hostId: "fixture-host" }));
  const credentials = new FileCredentialStore(join(directory, "broker.json"));
  let consumed = 0;
  const stdin = new Readable({
    read() {
      consumed++;
      this.push("fixture-secret-must-never-enter-hosted-body");
      this.push(null);
    },
  });
  await expect(
    runAccountsCommand(["apps", "github-secret", "--client-id", "fixture-app", "--secret-stdin"], {
      env: { CLANKIE_HOSTED_BOOTSTRAP_FILE: bootstrap, CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      credentials,
      stdin,
    }),
  ).rejects.toThrow("owner-run self-hosted OAuth app");
  expect(consumed).toBe(0);
  expect(await credentials.get("github-oauth-app")).toBeUndefined();
  expect(await readdir(directory)).toEqual(["bootstrap.json"]);
  stdin.destroy();
});
