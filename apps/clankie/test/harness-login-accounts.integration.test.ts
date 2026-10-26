import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  HARNESS_LOGIN_ACCOUNTS_PATH,
  HARNESS_LOGIN_CANCEL_PATH,
  HARNESS_LOGIN_CODE_PATH,
  HARNESS_LOGIN_REMOVE_PATH,
  HARNESS_LOGIN_START_PATH,
  HARNESS_LOGIN_STATUS_PATH,
  HarnessLoginAccountsResponseSchema,
} from "@clankie/protocol/harness-logins";
import { SettingsStore } from "@clankie/settings";
import { chooseWorkerAccount, createWorkerAccountsReader } from "../src/captain/harness-accounts.ts";
import { createHarnessLoginRoutes } from "../src/harness-login-routes.ts";
import { HarnessSignIns } from "../src/harness-logins.ts";
import { harnessAccountIdentities } from "../src/captain/harness-account-identities.ts";

/**
 * Several accounts per harness (VUH-2841, ADR 0221): the real `claude` and
 * `codex` CLIs in a scratch HOME, read by the same account reader hires use.
 * Codex homes sign in with a dummy API key, which needs no browser. Codex's
 * device sign-in reaches OpenAI, so it runs only with HARNESS_LOGIN_NETWORK=1.
 */
const exec = promisify(execFile);
const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
  closers.splice(0).forEach((close) => close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const installed = (command: string) => {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const harnessesInstalled = process.platform !== "win32" && installed("claude") && installed("codex");
const replayBin = join(import.meta.dirname, "fixtures", "harness-account-bin");
// Never the owner's own homes or keys.
const scratchEnv = (home: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key) &&
        !/^(HERDR_|CLANKIE_)/u.test(key),
    ),
  ),
  HOME: home,
});

async function fixture(replay = false) {
  const root = await mkdtemp(join(tmpdir(), "clankie-harness-accounts-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, ".claude-work"), { recursive: true });
  const env = scratchEnv(home);
  // The replayed Claude stands in for accounts a browser would sign in.
  if (replay) env.PATH = `${replayBin}:${env.PATH}`;
  else {
    for (const label of ["work", "team"]) {
      await mkdir(join(home, `.codex-${label}`), { recursive: true });
      await writeFile(join(home, `.codex-${label}`, "config.toml"), "");
    }
    // `team` stands in for a profile an earlier add created.
    await writeFile(join(home, ".codex-team", ".clankie-profile"), "{}\n");
    const codexLogin = async (codexHome: string | undefined, key: string) => {
      const child = execFile("codex", ["login", "--with-api-key"], {
        env: { ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      });
      child.stdin!.end(`${key}\n`);
      await new Promise((done, fail) => child.on("close", (code) => (code === 0 ? done(code) : fail(code))));
    };
    await codexLogin(undefined, "sk-dummy-default-0001");
    await codexLogin(join(home, ".codex-work"), "sk-dummy-work-0002");
    await codexLogin(join(home, ".codex-team"), "sk-dummy-team-0003");
  }
  const settings = new SettingsStore(join(root, "settings.json"));
  const identities = join(root, "identities.json");
  const read = createWorkerAccountsReader({
    identityPath: identities,
    settings: () => settings.load(),
    fleet: async () => ({ id: "mac", session: "default", ssh: { host: "mac.invalid", shell: "posix" } }),
    shell: () => async (command, timeout) =>
      (
        await exec("/bin/sh", ["-c", command], {
          env,
          timeout: timeout ?? 90_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
  });
  const harnesses = replay ? (["claude"] as const) : (["claude", "codex"] as const);
  const logins = new HarnessSignIns({
    env,
    accounts: () => read("mac", harnesses),
    rebind: (harness, labels, key) =>
      harnessAccountIdentities(identities).rebind("mac", harness, labels, key),
  });
  closers.push(() => logins.close());
  const app = createHarnessLoginRoutes(
    logins,
    async () => true,
    async () => "device:phone",
  );
  const call = async (path: string, body?: unknown) => {
    const response = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const until = async (sessionId: string, done: (body: Record<string, unknown>) => boolean) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const { body } = await call(HARNESS_LOGIN_STATUS_PATH, { sessionId });
      if (done(body)) return body;
      await new Promise((wait) => setTimeout(wait, 100));
    }
    throw Error(`sign-in ${sessionId} never settled`);
  };
  const gone = async (path: string) => {
    for (let attempt = 0; attempt < 100 && existsSync(path); attempt += 1)
      await new Promise((wait) => setTimeout(wait, 50));
    return !existsSync(path);
  };
  const accounts = async () =>
    HarnessLoginAccountsResponseSchema.parse((await call(HARNESS_LOGIN_ACCOUNTS_PATH)).body).harnesses;
  const fingerprint = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  return { home, call, until, gone, accounts, fingerprint, read: () => read("mac", harnesses) };
}

describe.skipIf(!harnessesInstalled)("several accounts per harness, signed in from a device", () => {
  it("lists every profile, adds one beside the default, and removes only what it may", async () => {
    const f = await fixture();
    const defaultAuth = join(f.home, ".codex", "auth.json");
    const before = f.fingerprint(defaultAuth);

    const listed = await f.accounts();
    const codex = listed.find((entry) => entry.harness === "codex")!;
    expect(codex.installed).toBe(true);
    expect(codex.accounts.map((row) => [row.profile, row.default, row.managed, row.signedIn])).toEqual([
      ["default", true, false, true],
      ["team", false, true, true],
      ["work", false, false, true],
    ]);
    const claude = listed.find((entry) => entry.harness === "claude")!;
    expect(claude.accounts.map((row) => [row.profile, row.default, row.signedIn])).toEqual([
      ["default", true, false],
      ["work", false, false],
    ]);
    // No home path, key or account ID crosses the API.
    expect(JSON.stringify(listed)).not.toMatch(/\/home|sk-dummy|\.codex/u);

    // A new Claude account goes into its own new home with the real login.
    const added = await f.call(HARNESS_LOGIN_START_PATH, { harness: "claude", add: { label: "second" } });
    expect(added.body).toMatchObject({ ok: true, profile: "second", state: "pending" });
    const sessionId = String(added.body.sessionId);
    const asked = await f.until(sessionId, (body) => body.state !== "pending");
    expect(asked.state).toBe("needs_code");
    expect(String(asked.url)).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/u);
    expect(existsSync(join(f.home, ".claude-second", ".clankie-profile"))).toBe(true);
    // One sign-in at a time, and nothing else is removed meanwhile.
    expect((await f.call(HARNESS_LOGIN_REMOVE_PATH, { harness: "codex", profile: "work" })).status).toBe(409);
    expect((await f.call(HARNESS_LOGIN_CANCEL_PATH, { sessionId })).body).toMatchObject({
      state: "cancelled",
      profile: "second",
    });
    // An unfinished add leaves nothing behind.
    expect(await f.gone(join(f.home, ".claude-second"))).toBe(true);

    // Re-signing a named profile targets that home and keeps it when cancelled.
    const resign = await f.call(HARNESS_LOGIN_START_PATH, { harness: "claude", profile: "work" });
    expect(resign.body).toMatchObject({ ok: true, profile: "work" });
    await f.until(String(resign.body.sessionId), (body) => body.state === "needs_code");
    await f.call(HARNESS_LOGIN_CANCEL_PATH, { sessionId: resign.body.sessionId });
    await new Promise((wait) => setTimeout(wait, 500));
    expect(existsSync(join(f.home, ".claude-work"))).toBe(true);

    // An add never reuses a label or home, and the default is never removed.
    for (const label of ["work", "default"])
      expect((await f.call(HARNESS_LOGIN_START_PATH, { harness: "codex", add: { label } })).body).toEqual({
        ok: false,
        error: "profile_exists",
      });
    expect((await f.call(HARNESS_LOGIN_REMOVE_PATH, { harness: "codex", profile: "default" })).body).toEqual({
      ok: false,
      error: "default_profile",
    });
    expect((await f.call(HARNESS_LOGIN_REMOVE_PATH, { harness: "codex", profile: "nope" })).status).toBe(404);
    expect(
      (await f.call(HARNESS_LOGIN_START_PATH, { harness: "codex", profile: "work", add: {} })).status,
    ).toBe(400);

    // The owner's own profile is signed out and stays; Clankie's is deleted.
    expect((await f.call(HARNESS_LOGIN_REMOVE_PATH, { harness: "codex", profile: "work" })).body).toEqual({
      ok: true,
      harness: "codex",
      profile: "work",
      deleted: false,
    });
    expect(existsSync(join(f.home, ".codex-work", "auth.json"))).toBe(false);
    expect((await f.call(HARNESS_LOGIN_REMOVE_PATH, { harness: "codex", profile: "team" })).body).toEqual({
      ok: true,
      harness: "codex",
      profile: "team",
      deleted: true,
    });
    expect(existsSync(join(f.home, ".codex-team"))).toBe(false);
    const after = (await f.accounts()).find((entry) => entry.harness === "codex")!;
    expect(after.accounts.map((row) => [row.profile, row.signedIn])).toEqual([
      ["default", true],
      ["work", false],
    ]);
    // Nothing above touched the default home's sign-in.
    expect(f.fingerprint(defaultAuth)).toBe(before);
  }, 180_000);

  it.skipIf(process.env.HARNESS_LOGIN_NETWORK !== "1")(
    "adds a Codex account with its real device sign-in, beside the default",
    async () => {
      const f = await fixture();
      const before = f.fingerprint(join(f.home, ".codex", "auth.json"));
      const added = await f.call(HARNESS_LOGIN_START_PATH, { harness: "codex", add: {} });
      expect(added.body).toMatchObject({ ok: true, profile: "account-2" });
      const shown = await f.until(String(added.body.sessionId), (body) => typeof body.userCode === "string");
      expect(shown.url).toBe("https://auth.openai.com/codex/device");
      expect(String(shown.userCode)).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4,8}$/u);
      expect(existsSync(join(f.home, ".codex-account-2", "config.toml"))).toBe(true);
      await f.call(HARNESS_LOGIN_CANCEL_PATH, { sessionId: added.body.sessionId });
      expect(await f.gone(join(f.home, ".codex-account-2"))).toBe(true);
      expect(f.fingerprint(join(f.home, ".codex", "auth.json"))).toBe(before);
    },
    120_000,
  );

  it("moves a re-signed profile's label to the account now signed in there, for hires too", async () => {
    const f = await fixture(true);
    const work = join(f.home, ".claude-work");
    // A ready profile: first-run setup done and the worker plugin installed.
    await writeFile(join(work, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    await mkdir(join(work, "plugins"), { recursive: true });
    await writeFile(
      join(work, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "clankie-worker@clankie": [] } }),
    );
    await writeFile(join(work, "fixture-identity.json"), JSON.stringify({ email: "alice@example.com" }));
    const hire = async () => {
      const choice = chooseWorkerAccount("mac", "claude", await f.read(), "work");
      return "account" in choice ? choice.account.identity : choice.refused;
    };
    expect(await hire()).toBe("alice@example.com");

    const signIn = async (body: Record<string, unknown>, email: string) => {
      const started = await f.call(HARNESS_LOGIN_START_PATH, body);
      const sessionId = String(started.body.sessionId);
      await f.until(sessionId, (state) => state.state === "needs_code");
      await f.call(HARNESS_LOGIN_CODE_PATH, { sessionId, code: `approve:${email}` });
      return f.until(
        sessionId,
        (state) => !["pending", "needs_code", "verifying"].includes(String(state.state)),
      );
    };
    // The vendor page signs Bob into the profile Alice held: said, and hires follow it.
    expect(await signIn({ harness: "claude", profile: "work" }, "bob@example.com")).toMatchObject({
      state: "complete",
      profile: "work",
      identityChanged: { before: "alice@example.com", after: "bob@example.com" },
    });
    expect(await hire()).toBe("bob@example.com");
    expect((await f.accounts())[0]!.accounts.find((row) => row.profile === "work")).toMatchObject({
      identity: "bob@example.com",
      signedIn: true,
      ready: true,
    });

    // A new profile that signs in an account already here says which, and stays the owner's call.
    expect(await signIn({ harness: "claude", add: {} }, "bob@example.com")).toMatchObject({
      state: "complete",
      profile: "account-2",
      duplicateOf: "work",
    });
    expect(existsSync(join(f.home, ".claude-account-2", ".clankie-profile"))).toBe(true);
    expect(
      (await f.call(HARNESS_LOGIN_REMOVE_PATH, { harness: "claude", profile: "account-2" })).body,
    ).toEqual({
      ok: true,
      harness: "claude",
      profile: "account-2",
      deleted: true,
    });
    expect(await hire()).toBe("bob@example.com");
  }, 120_000);
});
