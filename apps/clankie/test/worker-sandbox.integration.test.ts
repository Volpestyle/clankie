// VUH-2592: a hired worker's OS profile against the real protected keychain, with
// scratch keychains and a scratch file broker. The owner's Keychain is never used.
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createDefaultCredentialStore,
  ensureOperatorCredential,
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
  protectOperatorCredential,
  resolveOperatorCredential,
  rotateOperatorCredential,
} from "@clankie/credential-broker";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { createWorkerSandbox, WORKER_PANE_ENV } from "../src/worker-sandbox.ts";

const exec = promisify(execFile);
const darwinIt = it.skipIf(process.platform !== "darwin");
const probe = join(import.meta.dirname, "fixtures/worker-credential-probe.ts");
const tsx = import.meta.resolve("tsx/esm");
const helper = join(import.meta.dirname, "../../../packages/credential-broker/src/protected-keychain.py");
let root: string;
let env: NodeJS.ProcessEnv;
let token: string;

function run(command: string, args: readonly string[], childEnv: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// The unlock password lives in a scratch keychain, standing in for the login keychain.
// The helper creates it unlocked, never locking on sleep or idle. Nothing in these tests
// may ever reach a locked keychain through `security`, which would ask on the owner's screen.
async function createPasswordKeychain(path: string) {
  const created = spawn("/usr/bin/python3", [helper], { stdio: ["pipe", "pipe", "inherit"] });
  created.stdin.end(JSON.stringify({ op: "create", keychain: path, password: "scratch" }));
  const code = await new Promise((resolve) => created.on("close", resolve));
  if (code !== 0) throw new Error("Scratch keychain was not created");
}

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  // Short and canonical: Seatbelt compares resolved paths.
  root = await mkdtemp("/private/tmp/clankie-worker-sandbox-");
  await mkdir(join(root, "repo"));
  await mkdir(join(root, "home"));
  env = {
    ...process.env,
    CLANKIE_PROTECTED_KEYCHAIN: join(root, "clankie.keychain-db"),
    CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS: join(root, "passwords.keychain-db"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
  };
  await createPasswordKeychain(env.CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS!);
  token = mintOperatorToken();
  await writeFile(
    env.CLANKIE_CREDENTIALS_FILE!,
    JSON.stringify({ clankie_operator: { type: "api", key: token } }),
    {
      mode: 0o600,
    },
  );
  await writeFile(join(root, "repo", ".env.local"), "CLANKIE_OPERATOR_TOKEN=scratch-env-secret\n", {
    mode: 0o600,
  });
  await writeFile(join(root, "repo", "README.md"), "ordinary file\n");
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

darwinIt(
  "moves the operator credential where a sandboxed worker cannot read it, and the owner still can",
  async () => {
    expect(await protectOperatorCredential({ env })).toEqual({ created: true, moved: true });
    // The legacy copy is gone; the owner resolves the same token from the protected keychain.
    expect(JSON.parse(await readFile(env.CLANKIE_CREDENTIALS_FILE!, "utf8"))).not.toHaveProperty(
      "clankie_operator",
    );
    expect((await resolveOperatorCredential({ env }))?.token).toBe(token);
    expect(await protectOperatorCredential({ env })).toEqual({ created: false, moved: false });

    const sandbox = createWorkerSandbox({ env, repoRoot: join(root, "repo"), home: join(root, "home") });
    expect(sandbox).toBeDefined();
    const worker = { ...env, ...WORKER_PANE_ENV, ...sandbox!.env };
    const confined = (argv: readonly string[]) =>
      run(sandbox!.wrap(argv)[0]!, sandbox!.wrap(argv).slice(1), worker);

    // A `clankie` command in the worker sees no credential and says why.
    const unconfined = await run(process.execPath, ["--import", tsx, probe], { ...env, ...WORKER_PANE_ENV });
    expect(JSON.parse(unconfined.stdout)).toEqual({ outcome: "resolved", source: "store" });
    const inside = await confined([process.execPath, "--import", tsx, probe]);
    expect(JSON.parse(inside.stdout)).toEqual({ outcome: "refused", code: "worker_pane" });

    // Nor can it read the stores directly, the way a prompt-injected shell would.
    const keychainRead = await confined([
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      "bot.clankie.credentials",
      "-a",
      "clankie_operator",
      "-w",
      env.CLANKIE_PROTECTED_KEYCHAIN!,
    ]);
    expect(keychainRead.code).not.toBe(0);
    expect(keychainRead.stdout).not.toContain(token);
    // Renaming a directory above a protected file would give it a path the profile
    // doesn't name; that rename is refused, so the file stays unreadable.
    const renamed = await confined([
      "/bin/sh",
      "-c",
      `mv ${join(root, "repo")} ${join(root, "moved")} || mv ${root} ${root}-moved; cat ${join(root, "moved", ".env.local")} ${root}-moved/repo/.env.local`,
    ]);
    expect(renamed.stdout).not.toContain("scratch-env-secret");
    expect(renamed.stderr).toContain("Operation not permitted");
    for (const secret of [
      env.CLANKIE_PROTECTED_KEYCHAIN!,
      env.CLANKIE_CREDENTIALS_FILE!,
      join(root, "repo", ".env.local"),
    ]) {
      const read = await confined(["/bin/cat", secret]);
      expect(read.stderr, secret).toContain("Operation not permitted");
      expect(read.stdout).toBe("");
    }
    // Everything else stays usable, including other keychains: a harness keeps its own
    // login-keychain sign-in. The scratch password keychain stands in for it here.
    expect((await confined(["/bin/cat", join(root, "repo", "README.md")])).stdout).toBe("ordinary file\n");
    const other = env.CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS!;
    // Its known password, given non-interactively: `security` must never prompt.
    await exec("/usr/bin/security", ["unlock-keychain", "-p", "scratch", other]);
    await exec("/usr/bin/security", [
      "add-generic-password",
      "-s",
      "probe.harness",
      "-a",
      "probe",
      "-w",
      "harness-login",
      other,
    ]);
    const harnessLogin = await confined([
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      "probe.harness",
      "-w",
      other,
    ]);
    expect(harnessLogin.stdout.trim()).toBe("harness-login");

    // Outside the sandbox the same file reads: the profile, not the file mode, is the
    // boundary. Read its bytes; `security` on the protected keychain stays with the
    // broker, whose lock check never prompts.
    expect((await readFile(env.CLANKIE_PROTECTED_KEYCHAIN!)).length).toBeGreaterThan(0);
    expect((await resolveOperatorCredential({ env }))?.token).toBe(token);
  },
  60_000,
);

darwinIt(
  "keeps the service, its authenticator and the owner CLI on one bearer through protection, restart and rotation",
  async () => {
    const dir = await mkdtemp("/private/tmp/clankie-operator-composition-");
    try {
      const composed: NodeJS.ProcessEnv = {
        ...process.env,
        CLANKIE_PROTECTED_KEYCHAIN: join(dir, "clankie.keychain-db"),
        CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS: join(dir, "passwords.keychain-db"),
        CLANKIE_CREDENTIALS_FILE: join(dir, "credentials.json"),
      };
      delete composed.CLANKIE_OPERATOR_TOKEN;
      await createPasswordKeychain(composed.CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS!);
      // The service's general broker and its operator authenticator, as index.ts builds them.
      const broker = createDefaultCredentialStore({ env: composed });
      const started = await ensureOperatorCredential({ env: composed, store: broker, protectedFirst: true });
      const authenticate = createCredentialBackedOperatorAuthenticator({
        env: composed,
        store: broker,
        protectedFirst: true,
        identity: { operatorId: "local-operator", steerSourceLane: "tui" },
      });
      const asOwner = (token: string) =>
        authenticate(
          new Request("http://127.0.0.1/v1/operator", { headers: { authorization: `Bearer ${token}` } }),
        );
      expect(await asOwner(started.token)).toBeDefined();

      // The owner protects it while the service runs: the same bearer keeps working.
      expect(await protectOperatorCredential({ env: composed })).toMatchObject({ moved: true });
      expect(await broker.get(OPERATOR_CREDENTIAL_PROVIDER_ID)).toBeUndefined();
      expect(await asOwner(started.token)).toBeDefined();

      // A restart finds the protected bearer and mints no second one in the broker.
      const restartBroker = createDefaultCredentialStore({ env: composed });
      expect(
        (await ensureOperatorCredential({ env: composed, store: restartBroker, protectedFirst: true })).token,
      ).toBe(started.token);
      expect(await restartBroker.get(OPERATOR_CREDENTIAL_PROVIDER_ID)).toBeUndefined();
      expect((await resolveOperatorCredential({ env: composed }))?.token).toBe(started.token);

      // The owner's rotation lands in the protected store, and the running service follows it.
      const rotated = await rotateOperatorCredential({ env: composed });
      expect(rotated.token).not.toBe(started.token);
      expect(await asOwner(rotated.token)).toBeDefined();
      expect(await asOwner(started.token)).toBeUndefined();
      expect(await broker.get(OPERATOR_CREDENTIAL_PROVIDER_ID)).toBeUndefined();

      // A store a caller injects is used as given, even with the protected keychain present.
      const injected = new FileCredentialStore(join(dir, "injected.json"));
      const fixtureToken = mintOperatorToken();
      await injected.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: fixtureToken });
      expect((await resolveOperatorCredential({ env: composed, store: injected }))?.token).toBe(fixtureToken);
      const injectedAuth = createCredentialBackedOperatorAuthenticator({
        env: composed,
        store: injected,
        identity: { operatorId: "fixture-owner" },
      });
      const request = (token: string) =>
        new Request("http://127.0.0.1/v1/operator", { headers: { authorization: `Bearer ${token}` } });
      expect(await injectedAuth(request(fixtureToken))).toBeDefined();
      expect(await injectedAuth(request(rotated.token))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
