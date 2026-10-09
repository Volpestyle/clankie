import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, aroundEach, describe, expect, it } from "vitest";
import {
  FileCredentialStore,
  KeychainCredentialStore,
  GOOGLE_ACCOUNT_DEFINITIONS,
  GOOGLE_OAUTH_APP_PROVIDER_ID,
  GoogleOAuthError,
  googleAppSecret,
  googleCredentialMetadata,
  googlePickedFileIds,
  googleScopes,
  resolveGoogleBearer,
  type GoogleOAuthApp,
} from "@clankie/credential-broker";
import { AccountConnectionSchema, type GoogleAccountProvider } from "@clankie/protocol/accounts";
import { createGoogleAccounts } from "../src/google-accounts.ts";
import { createGoogleProviderFixture } from "./fixtures/google-provider.ts";
import { fixtureWork, withFixtureWork } from "../../../scripts/testing/fixture-work.ts";

aroundEach(withFixtureWork);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  fixtureWork().stop();
  await fixtureWork().drain();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function setup() {
  return fixtureWork().run(async () => {
    const provider = await createGoogleProviderFixture();
    cleanup.push(provider.close);
    const directory = await mkdtemp(join(tmpdir(), "clankie-google-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const config: GoogleOAuthApp = {
      clientId: "dev-client",
      redirectUri: "http://localhost:4317/account/connections/google/callback",
    };
    provider.addClient("dev-client", "fixture-client-secret");
    let clock = Date.now();
    const tenant = async (name: string) => {
      const path = join(directory, name, "credentials.json");
      const work = fixtureWork();
      const store = work.wrap(new FileCredentialStore(path));
      await store.set(GOOGLE_OAUTH_APP_PROVIDER_ID, {
        type: "api",
        key: "fixture-client-secret",
        metadata: { clientId: "dev-client" },
      });
      const request: typeof fetch = (input, init) =>
        work.run(() =>
          fetch(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([work.signal, init.signal]) : work.signal,
          }),
        );
      const options = {
        store,
        apps: async () => config,
        endpoints: provider.endpoints,
        now: () => clock,
        fetch: request,
        fetchImpl: request,
      };
      const accounts = work.wrap(createGoogleAccounts(options));
      const connect = async (
        capability: GoogleAccountProvider = "google-gmail",
        overrides: Parameters<typeof provider.issueCode>[1] = { subject: name, email: `${name}@example.com` },
      ) => {
        const start = await accounts.start(capability);
        if (!start.ok) throw new Error(`Start ${start.error}`);
        const code = provider.issueCode(start, overrides);
        return accounts.complete(
          capability,
          start.flowId,
          code,
          undefined,
          capability === "google-drive" ? ["chosen-file-1"] : undefined,
        );
      };
      return { path, store, options, accounts, connect };
    };
    return {
      provider,
      config,
      tenant,
      advance(ms: number) {
        clock += ms;
      },
    };
  });
}
describe("body-owned Google lifecycle across real HTTP and file broker boundaries", () => {
  it("cancellation drains a real HTTP refresh and its broker lock before fixture removal", async () => {
    const context = await setup();
    const tenant = await context.tenant("cancelled-refresh");
    await tenant.connect();
    context.advance(3600_000);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    context.provider.controls.refreshStarted = entered;
    context.provider.controls.refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshing = resolveGoogleBearer({ ...tenant.options, provider: "google-gmail" });
    const stopped = expect(refreshing).rejects.toBeInstanceOf(GoogleOAuthError);
    try {
      await started;
      fixtureWork().stop();
      await fixtureWork().drain();
      await stopped;
      await rm(dirname(tenant.path), { recursive: true });
      await expect(
        tenant.store.set("google-gmail", { type: "api", key: "late-fixture-write" }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(readFile(tenant.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
    }
  });
  it("catalog is visible without client setup and consent requests PKCE, nonce, offline access and exact minimum scopes", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    await tenant.store.delete(GOOGLE_OAUTH_APP_PROVIDER_ID);
    expect((await tenant.accounts.list()).map((c) => [c.name, c.group, c.status, c.scopes])).toEqual([
      ["Gmail", "google", "unconfigured", []],
      ["Google Calendar", "google", "unconfigured", []],
      ["Google Drive", "google", "unconfigured", []],
    ]);
    expect(await tenant.accounts.start("google-gmail")).toEqual({ ok: false, error: "unconfigured" });
    await tenant.store.set(GOOGLE_OAUTH_APP_PROVIDER_ID, {
      type: "api",
      key: "fixture-client-secret",
      metadata: { clientId: "dev-client" },
    });
    for (const capability of ["google-gmail", "google-calendar", "google-drive"] as const) {
      const start = await tenant.accounts.start(capability);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const params = new URL(start.authorizeUrl).searchParams;
      expect(params.get("scope")?.split(" ")).toEqual(googleScopes(capability));
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("access_type")).toBe("offline");
      expect(params.get("include_granted_scopes")).toBe("false");
      expect(params.get("nonce")).toHaveLength(43);
      expect(params.has("code_verifier")).toBe(false);
      expect(params.has("client_secret")).toBe(false);
    }
    expect((await tenant.accounts.list())[0]?.status).toBe("awaiting_consent");
  });
  it("rejects a configured foreign callback path before opening consent", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    for (const redirect of [
      "http://localhost:4317/auth/google/callback",
      "https://fleet.example/account/connections/google/callback/",
      "https://fleet.example/foreign/callback",
    ]) {
      context.config.redirectUri = redirect;
      expect(await tenant.accounts.start("google-gmail")).toEqual({ ok: false, error: "unconfigured" });
      expect((await tenant.accounts.list())[0]?.status).toBe("unconfigured");
    }
    expect(context.provider.seen).toHaveLength(0);
  });
  it("stores verified identity and broker tokens while public sheets expose no token or secret", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    expect((await tenant.connect()).ok).toBe(true);
    const credential = await tenant.store.get("google-gmail");
    expect(credential?.type).toBe("oauth");
    if (credential?.type !== "oauth") return;
    const sheets = await tenant.accounts.list();
    sheets.forEach((sheet) => AccountConnectionSchema.parse(sheet));
    expect(sheets[0]).toMatchObject({
      account: "alice@example.com",
      status: "connected",
      readOnly: true,
      group: "google",
    });
    expect(sheets[1]?.status).toBe("not_connected");
    for (const secret of [credential.access, credential.refresh, "fixture-client-secret"])
      expect(JSON.stringify(sheets)).not.toContain(secret);
  });
  it.each(["removed app secret", "invalid same-client callback"])(
    "connected catalog reports unconfigured after %s and check makes no provider request",
    async (missing) => {
      const context = await setup();
      const tenant = await context.tenant("alice");
      expect((await tenant.connect()).ok).toBe(true);
      const requestsBefore = context.provider.seen.length;
      if (missing === "removed app secret") await tenant.store.delete(GOOGLE_OAUTH_APP_PROVIDER_ID);
      else context.config.redirectUri = "http://localhost:4317/foreign/callback";
      expect((await tenant.accounts.list())[0]).toMatchObject({
        account: "alice@example.com",
        status: "unconfigured",
      });
      expect(await tenant.accounts.check("google-gmail")).toEqual({ ok: false, error: "unconfigured" });
      await expect(
        resolveGoogleBearer({ ...tenant.options, provider: "google-gmail" }),
      ).rejects.toMatchObject({ code: "unconfigured" });
      expect(context.provider.seen).toHaveLength(requestsBefore);
    },
  );
  it("rejects cross-tenant state and replay without exchanging either code", async () => {
    const context = await setup();
    const alice = await context.tenant("alice");
    const bob = await context.tenant("bob");
    const start = await alice.accounts.start("google-gmail");
    if (!start.ok) throw new Error("Start failed");
    const code = context.provider.issueCode(start, { subject: "alice", email: "alice@example.com" });
    expect(await bob.accounts.complete("google-gmail", start.flowId, code)).toEqual({
      ok: false,
      error: "unknown_flow",
    });
    expect((await alice.accounts.complete("google-gmail", start.flowId, code)).ok).toBe(true);
    expect(await alice.accounts.complete("google-gmail", start.flowId, code)).toEqual({
      ok: false,
      error: "unknown_flow",
    });
    expect(context.provider.seen.filter((r) => r.path === "/token")).toHaveLength(1);
    expect(await bob.store.get("google-gmail")).toBeUndefined();
  });
  it("wrong capability, expired state and changed client binding cannot store tokens", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    const start = await tenant.accounts.start("google-gmail");
    if (!start.ok) throw new Error("Start failed");
    expect(await tenant.accounts.complete("google-calendar", start.flowId, "code")).toEqual({
      ok: false,
      error: "unknown_flow",
    });
    const expiring = await tenant.accounts.start("google-gmail");
    if (!expiring.ok) throw new Error("Start failed");
    context.advance(11 * 60_000);
    expect(await tenant.accounts.complete("google-gmail", expiring.flowId, "code")).toEqual({
      ok: false,
      error: "expired",
    });
    const changed = await tenant.accounts.start("google-gmail");
    if (!changed.ok) throw new Error("Start failed");
    context.config.redirectUri = "http://localhost:4318/account/connections/google/callback";
    expect(await tenant.accounts.complete("google-gmail", changed.flowId, "code")).toEqual({
      ok: false,
      error: "unknown_flow",
    });
    expect(context.provider.seen.filter((r) => r.path === "/token")).toHaveLength(0);
  });
  it.each([
    ["aud", { claims: { aud: "another-client" } }],
    ["issuer", { claims: { iss: "https://attacker.example" } }],
    ["nonce", { claims: { nonce: "different-nonce" } }],
    ["expiry", { claims: { exp: 1 } }],
    ["email verification", { claims: { email_verified: false } }],
    ["signature", { invalidSignature: true }],
    ["missing identity", { omitIdToken: true }],
  ])("rejects an invalid verified %s", async (_label, invalid) => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    expect(
      await tenant.connect("google-gmail", { subject: "alice", email: "alice@example.com", ...invalid }),
    ).toEqual({ ok: false, error: "provider_rejected" });
    expect(await tenant.store.get("google-gmail")).toBeUndefined();
  });
  it("accepts official email alias and approved read-only grant union but rejects write, missing or unrelated scopes", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    for (const scopes of [
      "openid email",
      `${googleScopes("google-gmail").join(" ")} https://www.googleapis.com/auth/gmail.modify`,
      `${googleScopes("google-gmail").join(" ")} https://www.googleapis.com/auth/unknown.readonly`,
    ]) {
      expect(
        await tenant.connect("google-gmail", { subject: "alice", email: "alice@example.com", scopes }),
      ).toEqual({ ok: false, error: "provider_rejected" });
    }
    const union = [...new Set([...googleScopes("google-gmail"), ...googleScopes("google-calendar")])]
      .join(" ")
      .replace(" email ", " https://www.googleapis.com/auth/userinfo.email ");
    expect(
      (await tenant.connect("google-gmail", { subject: "alice", email: "alice@example.com", scopes: union }))
        .ok,
    ).toBe(true);
    expect((await tenant.accounts.list())[1]?.status).toBe("not_connected");
  });
  it("two broker instances serialize refresh and preserve a refresh token omitted by Google", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    await tenant.connect();
    const before = await tenant.store.get("google-gmail");
    context.advance(3600_000);
    context.provider.controls.omitRefreshScope = true;
    const secondStore = fixtureWork().wrap(new FileCredentialStore(tenant.path));
    const resolve = (store: FileCredentialStore) =>
      resolveGoogleBearer({ ...tenant.options, store, provider: "google-gmail" });
    const tokens = await Promise.all([resolve(tenant.store), resolve(secondStore)]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(
      context.provider.seen.filter(
        (r) => r.path === "/token" && new URLSearchParams(r.body).get("grant_type") === "refresh_token",
      ),
    ).toHaveLength(1);
    const after = await secondStore.get("google-gmail");
    expect(after?.type === "oauth" && after.refresh).toBe(before?.type === "oauth" && before.refresh);
  });
  it("separate native Node processes share one broker lock during Google refresh", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    await tenant.connect();
    const now = Date.now() + 3600_000;
    const work = fixtureWork();
    const run = () =>
      work.run(
        () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                import.meta.resolve("tsx/esm"),
                fileURLToPath(new URL("./fixtures/google-broker-process.ts", import.meta.url)),
                JSON.stringify({
                  path: tenant.path,
                  config: context.config,
                  endpoints: context.provider.endpoints,
                  now,
                }),
              ],
              { stdio: ["ignore", "pipe", "pipe"], signal: work.signal },
            );
            let output = "";
            let errors = "";
            child.stdout.on("data", (chunk) => {
              output += String(chunk);
            });
            child.stderr.on("data", (chunk) => {
              errors += String(chunk);
            });
            let failure: Error | undefined;
            child.on("error", (error) => {
              failure = error;
            });
            child.on("close", (code) =>
              failure
                ? reject(failure)
                : code === 0
                  ? resolve(output)
                  : reject(new Error(`Broker process failed ${code}: ${errors}`)),
            );
          }),
      );
    expect(await Promise.all([run(), run()])).toEqual(["refreshed\n", "refreshed\n"]);
    expect(
      context.provider.seen.filter(
        (r) => r.path === "/token" && new URLSearchParams(r.body).get("grant_type") === "refresh_token",
      ),
    ).toHaveLength(1);
  });
  it("invalid_grant requires reconnection while a provider outage preserves the grant and reports unavailable", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    await tenant.connect();
    const initial = await tenant.store.get("google-gmail");
    context.provider.controls.refreshStatus = 503;
    expect(await tenant.accounts.check("google-gmail")).toEqual({ ok: false, error: "unavailable" });
    const unavailable = await tenant.store.get("google-gmail");
    expect(googleCredentialMetadata(unavailable)).toMatchObject({
      status: "unavailable",
      reason: "provider_unavailable",
    });
    expect(unavailable?.type === "oauth" && unavailable.refresh).toBe(
      initial?.type === "oauth" && initial.refresh,
    );
    context.provider.controls.refreshStatus = 400;
    expect(await tenant.accounts.check("google-gmail")).toEqual({ ok: false, error: "provider_rejected" });
    expect((await tenant.accounts.list())[0]).toMatchObject({
      status: "reconnect_required",
      reason: "invalid_grant",
    });
    await expect(resolveGoogleBearer({ ...tenant.options, provider: "google-gmail" })).rejects.toMatchObject({
      code: "reconnect_required",
    });
  });
  it("first consent cannot borrow a refresh token from another subject or capability", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    await tenant.connect();
    expect(
      await tenant.connect("google-calendar", {
        subject: "alice",
        email: "alice@example.com",
        omitRefresh: true,
      }),
    ).toEqual({ ok: false, error: "provider_rejected" });
    expect(
      await tenant.connect("google-gmail", { subject: "bob", email: "bob@example.com", omitRefresh: true }),
    ).toEqual({ ok: false, error: "provider_rejected" });
    expect(
      (
        await tenant.connect("google-gmail", {
          subject: "alice",
          email: "alice@example.com",
          omitRefresh: true,
        })
      ).ok,
    ).toBe(true);
    expect((await tenant.accounts.list())[0]?.account).toBe("alice@example.com");
  });
  it("Drive first uses selected-file Picker consent without OIDC scopes and verifies Drive account identity", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    const start = await tenant.accounts.start("google-drive");
    if (!start.ok) throw new Error("Start failed");
    const params = new URL(start.authorizeUrl).searchParams;
    expect(params.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("trigger_onepick")).toBe("true");
    const code = context.provider.issueCode(start, { subject: "alice", email: "alice@example.com" });
    const result = await tenant.accounts.complete("google-drive", start.flowId, code, undefined, [
      "chosen-file-1",
      "chosen-file-2",
    ]);
    expect(result).toMatchObject({ ok: true, connection: { readOnly: false, account: "alice@example.com" } });
    const credential = await tenant.store.get("google-drive");
    expect(googleCredentialMetadata(credential)).toMatchObject({
      subject: "drive:permission-alice",
      scopes: "https://www.googleapis.com/auth/drive.file",
    });
    expect(googlePickedFileIds(credential)).toEqual(["chosen-file-1", "chosen-file-2"]);
    expect(context.provider.seen.filter((r) => r.path === "/jwks")).toHaveLength(0);
    expect(context.provider.seen.filter((r) => r.path === "/drive/about")).toHaveLength(1);
    context.advance(3600_000);
    expect(await resolveGoogleBearer({ ...tenant.options, provider: "google-drive" })).toMatch(/^access-/u);
    expect(context.provider.seen.filter((r) => r.path === "/drive/about")).toHaveLength(2);
    expect(GOOGLE_ACCOUNT_DEFINITIONS["google-drive"].tools).toEqual([
      "get_file_metadata",
      "read_file_content",
      "download_file_content",
    ]);
  });
  it("preserves the protocol maximum selected Drive IDs through broker persistence and the catalog", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    const selected = Array.from(
      { length: 100 },
      (_, index) => String(index).padStart(3, "0") + "f".repeat(253),
    );
    const start = await tenant.accounts.start("google-drive");
    if (!start.ok) throw new Error("Start failed");
    const code = context.provider.issueCode(start, { subject: "alice", email: "alice@example.com" });
    const result = await tenant.accounts.complete("google-drive", start.flowId, code, undefined, selected);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(AccountConnectionSchema.parse(result.connection).selectedFileIds).toEqual(selected);
    expect(googlePickedFileIds(await tenant.store.get("google-drive"))).toEqual(selected);
    expect((await tenant.accounts.list())[2]?.selectedFileIds).toEqual(selected);
  });
  it("Drive rejects absent selection, unsafe IDs and scopes combined with drive.file", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    for (const selection of [undefined, [], ["file/../../other"], ["f".repeat(257)]]) {
      const start = await tenant.accounts.start("google-drive");
      if (!start.ok) throw new Error("Start failed");
      const code = context.provider.issueCode(start, { subject: "alice", email: "alice@example.com" });
      expect(
        await tenant.accounts.complete("google-drive", start.flowId, code, undefined, selection),
      ).toEqual({ ok: false, error: "provider_rejected" });
    }
    expect(context.provider.seen.filter((r) => r.path === "/token")).toHaveLength(0);
    expect(
      await tenant.connect("google-drive", {
        subject: "alice",
        email: "alice@example.com",
        scopes: "https://www.googleapis.com/auth/drive.file openid email",
      }),
    ).toEqual({ ok: false, error: "provider_rejected" });
    expect(await tenant.store.get("google-drive")).toBeUndefined();
  });
  it("revoking Drive also disables Gmail and Calendar for the same verified Google account", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    await tenant.connect("google-gmail");
    await tenant.connect("google-calendar");
    await tenant.connect("google-drive");
    expect(await tenant.accounts.disconnect("google-drive")).toEqual({ ok: true, revoked: true });
    expect((await tenant.accounts.list()).map((connection) => connection.status)).toEqual([
      "disconnected",
      "disconnected",
      "disconnected",
    ]);
    expect(context.provider.seen.filter((r) => r.path === "/revoke")).toHaveLength(1);
    expect((await tenant.connect("google-drive")).ok).toBe(true);
    expect((await tenant.accounts.list()).map((connection) => connection.status)).toEqual([
      "disconnected",
      "disconnected",
      "connected",
    ]);
  });
  it.each([false, true])(
    "Keychain partial publication cannot revive a sibling after secret reprovisioning (app missing: %s)",
    async (appMissing) => {
      const context = await setup();
      const tenant = await context.tenant("alice");
      await tenant.connect();
      await tenant.connect("google-calendar");
      const items = new Map<string, string>();
      let rejectCalendarDisable = false;
      const store = new KeychainCredentialStore({
        service: `google-fixture-${tenant.path}`,
        execFile: async (_file, args) => {
          const account = args[args.indexOf("-a") + 1]!;
          if (args[0] === "find-generic-password") {
            const item = items.get(account);
            if (item === undefined) throw new Error("item could not be found");
            return { stdout: item + "\n", stderr: "" };
          }
          if (args[0] === "add-generic-password") {
            const value = args[args.indexOf("-w") + 1]!;
            if (
              account === "google-calendar" &&
              rejectCalendarDisable &&
              value.includes('"status":"disconnected"')
            )
              throw new Error("Fixture simulates failed Keychain item write");
            items.set(account, value);
          } else if (args[0] === "delete-generic-password") items.delete(account);
          else throw new Error("Unexpected fixture command");
          return { stdout: "", stderr: "" };
        },
      });
      for (const id of [GOOGLE_OAUTH_APP_PROVIDER_ID, "google-gmail", "google-calendar"]) {
        const credential = await tenant.store.get(id);
        if (credential) await store.set(id, credential);
      }
      if (appMissing) await store.delete(GOOGLE_OAUTH_APP_PROVIDER_ID);
      const requestsBefore = context.provider.seen.length;
      rejectCalendarDisable = true;
      const accounts = createGoogleAccounts({ ...tenant.options, store });
      await expect(accounts.disconnect("google-gmail")).rejects.toThrow("failed Keychain");
      const marker = await store.get(GOOGLE_OAUTH_APP_PROVIDER_ID);
      expect(marker?.type).toBe("api");
      if (appMissing) expect(googleAppSecret(marker, "dev-client")).toBeUndefined();
      await store.updateMany([GOOGLE_OAUTH_APP_PROVIDER_ID], async (group) => {
        const app = group[GOOGLE_OAUTH_APP_PROVIDER_ID];
        group[GOOGLE_OAUTH_APP_PROVIDER_ID] = {
          type: "api",
          key: "fixture-client-secret",
          metadata: { ...(app?.type === "api" ? app.metadata : {}), clientId: "dev-client" },
        };
        return group;
      });
      // Model an actual partially published store, not an already-disabled token.
      expect(googleCredentialMetadata(await store.get("google-calendar"))?.status).toBe("connected");
      await expect(
        resolveGoogleBearer({ ...tenant.options, store, provider: "google-calendar" }),
      ).rejects.toMatchObject({ code: "disconnected" });
      expect(context.provider.seen).toHaveLength(requestsBefore);
      expect((await accounts.list())[1]?.status).toBe("disconnected");
      expect(await store.list()).not.toHaveProperty(GOOGLE_OAUTH_APP_PROVIDER_ID);
      rejectCalendarDisable = false;
      expect(await accounts.disconnect("google-calendar")).toEqual({ ok: true, revoked: true });
    },
  );
  it("Google app secret remains write-only through generic broker summaries", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    expect(await tenant.store.list()).not.toHaveProperty(GOOGLE_OAUTH_APP_PROVIDER_ID);
  });
  it("cross-instance refresh and project revoke cannot restore any disabled sibling or affect another tenant", async () => {
    const context = await setup();
    const alice = await context.tenant("alice");
    const bob = await context.tenant("bob");
    await alice.connect();
    await alice.connect("google-calendar");
    await bob.connect();
    context.advance(3600_000);
    const start = await alice.accounts.start("google-drive");
    if (!start.ok) throw new Error("Start failed");
    const code = context.provider.issueCode(start, { subject: "alice", email: "alice@example.com" });
    let release!: () => void;
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    context.provider.controls.refreshStarted = notify;
    context.provider.controls.refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshing = resolveGoogleBearer({ ...alice.options, provider: "google-gmail" });
    await started;
    const secondAccounts = createGoogleAccounts({
      ...alice.options,
      store: fixtureWork().wrap(new FileCredentialStore(alice.path)),
    });
    const disconnecting = secondAccounts.disconnect("google-calendar");
    release();
    await refreshing;
    expect(await disconnecting).toEqual({ ok: true, revoked: true });
    expect(await alice.accounts.complete("google-drive", start.flowId, code)).toEqual({
      ok: false,
      error: "unknown_flow",
    });
    for (const capability of ["google-gmail", "google-calendar"] as const) {
      await expect(resolveGoogleBearer({ ...alice.options, provider: capability })).rejects.toBeInstanceOf(
        GoogleOAuthError,
      );
      const credential = await alice.store.get(capability);
      expect(credential?.type === "oauth" && [credential.access, credential.refresh]).toEqual(["", ""]);
    }
    expect(await resolveGoogleBearer({ ...bob.options, provider: "google-gmail" })).toMatch(/^access-/u);
    const body = await readFile(alice.path, "utf8");
    expect(body).not.toContain('"status": "connected"');
  });
  it("failed revoke disables all siblings first, retries at most three times and never claims remote revocation", async () => {
    const context = await setup();
    const tenant = await context.tenant("alice");
    await tenant.connect();
    await tenant.connect("google-calendar");
    context.provider.controls.revokeStatus = 503;
    expect(await tenant.accounts.disconnect("google-gmail")).toMatchObject({ ok: true, revoked: false });
    for (const capability of ["google-gmail", "google-calendar"] as const) {
      const credential = await tenant.store.get(capability);
      expect(credential?.type === "oauth" && credential.access).toBe("");
      expect(googleCredentialMetadata(credential)).toMatchObject({
        status: "disconnected",
        revocationPending: "true",
      });
      await expect(resolveGoogleBearer({ ...tenant.options, provider: capability })).rejects.toMatchObject({
        code: "disconnected",
      });
    }
    expect(await tenant.accounts.start("google-gmail")).toEqual({ ok: false, error: "unavailable" });
    for (let attempt = 0; attempt < 5; attempt++) {
      context.advance(5 * 60_000);
      await tenant.accounts.list();
    }
    expect(context.provider.seen.filter((r) => r.path === "/revoke")).toHaveLength(3);
    expect((await tenant.accounts.list())[0]).toMatchObject({
      status: "disconnected",
      revocationPending: true,
    });
    expect(GOOGLE_ACCOUNT_DEFINITIONS["google-drive"].access).toContain("including editing permission");
  });
});
