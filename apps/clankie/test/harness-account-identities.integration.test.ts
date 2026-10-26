import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  MachineWorkerAccountsSchema,
  UsageReportSchema,
  harnessAccountName,
} from "@clankie/protocol/worker-accounts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkerAccountsReader, chooseWorkerAccount } from "../src/captain/harness-accounts.ts";
import {
  HarnessAccountIdentities,
  harnessAccountIdentities,
  harnessAccountIdentityPath,
} from "../src/captain/harness-account-identities.ts";
import { runClaudeAccountsCommand } from "../../tui/src/command/claude-accounts.ts";
import { runCodexAccountsCommand } from "../../tui/src/command/codex-accounts.ts";
import { runUsageCommand } from "../../tui/src/command/usage.ts";
import { captainTools } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Native identity transports are fixture executables, not credentials or a model turn.
 * Everything above that boundary is real: discovery, persistence, HTTP schemas, CLI and hire refusal.
 */
it("discovers identities from a 0755 state directory once per home, merges duplicates, and keeps preferences and history with the identity after a re-sign", async () => {
  root = await mkdtemp(join(tmpdir(), "clankie-identity-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const nativeLog = join(home, "native-identity-reads.jsonl");
  await mkdir(home);
  await mkdir(bin);
  const executable =
    `#!${process.execPath}\n` +
    String.raw`
const fs = require("node:fs"), path = require("node:path"), rl = require("node:readline");
const harness = path.basename(process.argv[1]);
const home = process.env[harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] || path.join(process.env.HOME, "." + harness);
const identity = JSON.parse(fs.readFileSync(path.join(home, "identity.json"), "utf8"));
const log = value => fs.appendFileSync(path.join(process.env.HOME, "native-identity-reads.jsonl"), JSON.stringify({ harness, home, ...value }) + "\n");
if (harness === "claude") {
 const args = process.argv.slice(2);
 if (args[0] === "auth" && args[1] === "status") {
  log({method:"auth status", delayed:Boolean(identity.delayFile)});
  const output = JSON.stringify({ loggedIn:true, authMethod:"claude.ai", email:identity.hideIdentity ? undefined : identity.email, accountId:identity.hideIdentity ? undefined : identity.id, orgId:"fixture-org", subscriptionType:"max" });
  if(identity.delayFile) { const timer=setInterval(()=>{if(fs.existsSync(identity.delayFile)){clearInterval(timer);process.stdout.write(output);}},10); }
  else process.stdout.write(output);
 } else if(args[0] === "--version") process.stdout.write("2.1.295");
 else if(args[0] === "-p" && args[1] === "/usage") process.stdout.write(JSON.stringify({local_command:"usage", result:identity.noUsage ? "" : "Current week (all models): " + identity.used + "% used · resets Oct 14 at 5:59am (America/Chicago)"}));
 else process.exitCode = 71;
} else {
 rl.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if(request.method === "initialized") return;
  let result;
  if(request.method === "initialize") result = {};
  else if(request.method === "account/read" && request.params.refreshToken === false) {
   log({method:request.method, refreshToken:request.params.refreshToken});
   result = { account:{ type:"chatgpt", email:identity.email, accountId:identity.id, planType:"pro" } };
  } else if(request.method === "account/rateLimits/read") result = identity.noUsage ? {} : {rateLimits:{primary:{usedPercent:identity.used,windowDurationMins:300,resetsAt:1791975600}}};
  else { process.exit(72); }
  process.stdout.write(JSON.stringify({id:request.id,result})+"\n");
 });
}
`;
  for (const harness of ["claude", "codex"] as const) {
    await writeFile(join(bin, harness), executable, { mode: 0o755 });
    for (const [suffix, id] of [
      ["", "a"],
      ["-work", "a"],
      ["-second", "b"],
    ]) {
      const profile = join(home, `.${harness}${suffix}`);
      await mkdir(join(profile, "plugins"), { recursive: true });
      await writeFile(
        join(profile, "identity.json"),
        JSON.stringify({
          id,
          email: `${id}@example.com`,
          used: suffix === "-work" && id === "a" ? 100 : id === "a" ? 82 : 20,
        }),
      );
      if (harness === "codex") await writeFile(join(profile, "config.toml"), "");
      else {
        const metadata = {
          hasCompletedOnboarding: true,
          oauthAccount: {
            emailAddress: `${id}@example.com`,
            accountUuid: id,
            organizationUuid: "fixture-org",
            organizationRateLimitTier: "default_claude_max_20x",
          },
        };
        await writeFile(join(profile, ".claude.json"), JSON.stringify(metadata));
        if (!suffix) await writeFile(join(home, ".claude.json"), JSON.stringify(metadata));
        await writeFile(
          join(profile, "plugins", "installed_plugins.json"),
          JSON.stringify({ plugins: { "clankie-worker@clankie": [] } }),
        );
      }
    }
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    claudeAccounts: [{ label: "duplicate", home: join(home, ".claude") }],
    codexAccounts: [{ label: "duplicate", home: join(home, ".codex") }],
    workerAccountHolds: [{ machine: "local", harness: "claude", label: "work", reason: "saved for lead" }],
  }));
  const notices: string[] = [];
  const stateDir = join(root, "captain");
  await mkdir(stateDir, { mode: 0o755 });
  await chmod(stateDir, 0o755);
  const identityPath = harnessAccountIdentityPath(stateDir);
  expect((await stat(stateDir)).mode & 0o777).toBe(0o755);
  expect((await stat(join(stateDir, "harness-account-identities"))).mode & 0o777).toBe(0o700);
  const read = createWorkerAccountsReader({
    identityPath,
    settings: () => settings.load(),
    fleet: async () => undefined,
    notifyIdentityChange: (message) => {
      notices.push(message);
      return true;
    },
  });
  const first = await read(undefined, ["claude", "codex"]);
  expect(first.unavailable).toBeUndefined();
  expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
  expect(first.accounts).toHaveLength(4); // six homes, four signed-in accounts
  const a = first.accounts.find(
    (account) => account.harness === "claude" && account.identity === "a@example.com",
  )!;
  const b = first.accounts.find(
    (account) => account.harness === "claude" && account.identity === "b@example.com",
  )!;
  expect(a.homes).toHaveLength(2);
  expect(a.headroom).toBe(0);
  expect(a.usable).toBe(false); // changing homes cannot escape the identity's limit pool
  expect(a.usage?.windows[0]?.usedPercent).toBe(100);
  expect(a.held).toEqual({ reason: "saved for lead" });
  expect(a.aliases).toEqual(expect.arrayContaining(["default", "duplicate", "work"]));
  expect(b.homes).toHaveLength(1);
  expect(chooseWorkerAccount("local", "claude", first, b.label)).toMatchObject({
    account: { label: b.label, home: join(home, ".claude-second") },
  });
  expect(first.accounts.every((account) => /^account-[a-f0-9]{32}$/u.test(account.label))).toBe(true);
  const queries = (await readFile(nativeLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(queries).toHaveLength(6);
  expect(new Set(queries.map((query) => query.home)).size).toBe(6);
  expect(
    queries.filter((query) => query.harness === "codex").every((query) => query.refreshToken === false),
  ).toBe(true);

  // Optional manual evidence runs compare the original fetched-main probe in
  // this same fake HOME; normal acceptance checks need no other checkout.
  let baseline: unknown;
  if (process.env.VUH2145_BASELINE_SOURCE) {
    const source = await readFile(process.env.VUH2145_BASELINE_SOURCE, "utf8");
    const probe = source.split("const PROBE = String.raw`", 2)[1]?.split("\n`", 1)[0];
    if (!probe) throw new Error("Missing baseline probe source");
    const profiles = Object.fromEntries(
      ["claude", "codex"].map((harness) => [
        harness,
        [
          { label: "default", home: join(home, `.${harness}`) },
          { label: "duplicate", home: join(home, `.${harness}`) },
          { label: "work", home: join(home, `.${harness}-work`) },
          { label: "second", home: join(home, `.${harness}-second`) },
        ],
      ]),
    );
    const raw = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        probe,
        JSON.stringify({
          harnesses: ["claude", "codex"],
          timeoutMs: 20000,
          claudeUsageVersion: 2001295,
          profiles,
        }),
      ],
      { env: process.env, maxBuffer: 1024 * 1024, timeout: 30000 },
    );
    baseline = JSON.parse(raw.stdout);
    expect((baseline as { accounts: unknown[] }).accounts).toHaveLength(8);
  }

  const registry = harnessAccountIdentities(identityPath);
  const captain = createStubCaptain();
  captain.resolveWorkerAccountLabel = (machine, harness, label) => registry.resolve(machine, harness, label);
  const app = await createClankieApp({
    captain,
    settings,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    workerAccounts: read,
  });
  const ownerFetcher = {
    fetch: async (path: string, init?: RequestInit) =>
      app.app.request(path, { ...init, headers: { ...init?.headers, authorization: "Bearer owner" } }),
  };
  const api = MachineWorkerAccountsSchema.parse(
    await (await ownerFetcher.fetch("/v1/worker-accounts")).json(),
  );
  const claude = await runClaudeAccountsCommand([], { settings, ownerFetcher });
  const codex = await runCodexAccountsCommand([], { settings, ownerFetcher });
  expect([...claude.accounts, ...codex.accounts].map((account) => account.label).sort()).toEqual(
    api.accounts.map((account) => account.label).sort(),
  );
  const usage = UsageReportSchema.parse(await runUsageCommand([], { ownerFetcher }));
  expect(usage.accounts.map((account) => account.label).sort()).toEqual(
    api.accounts.map((account) => account.label).sort(),
  );
  expect(usage.accounts.map(harnessAccountName)).toEqual(api.accounts.map(harnessAccountName));
  expect(usage.accounts.map(harnessAccountName).join(" ")).not.toContain("default");

  // Hold an older native identity read open while a newer read sees B.
  // Delayed completion must not manufacture a second/reverse re-sign.
  const release = join(home, "release-native-auth");
  await writeFile(
    join(home, ".claude-work", "identity.json"),
    JSON.stringify({ id: "a", email: "a@example.com", used: 82, delayFile: release }),
  );
  const olderRead = read(undefined, ["claude"]);
  await vi.waitFor(async () =>
    expect((await readFile(nativeLog, "utf8")).includes('"delayed":true')).toBe(true),
  );

  // The configured folder re-signs A -> B. B supplies no usage in either home,
  // so only B's own previous reading may survive in the HTTP usage cache.
  await writeFile(
    join(home, ".claude-work", "identity.json"),
    JSON.stringify({ id: "b", email: "b@example.com", noUsage: true }),
  );
  await writeFile(
    join(home, ".claude-second", "identity.json"),
    JSON.stringify({ id: "b", email: "b@example.com", noUsage: true }),
  );
  const after = await read(undefined, ["claude"]);
  await writeFile(release, "release");
  const late = await olderRead;
  expect(late.accounts.find((account) => account.label === a.label)?.homes).toHaveLength(1);
  expect(after.accounts).toHaveLength(2);
  const oldIdentity = after.accounts.find((account) => account.label === a.label)!;
  const newIdentity = after.accounts.find((account) => account.label === b.label)!;
  expect(oldIdentity.homes).toHaveLength(1);
  expect(newIdentity.homes).toHaveLength(2);
  expect(oldIdentity.held).toEqual({ reason: "saved for lead" });
  expect(newIdentity.held).toBeUndefined();
  expect(chooseWorkerAccount("local", "claude", after, "work")).toMatchObject({
    account: { label: a.label, home: join(home, ".claude") },
  });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("a@example.com to b@example.com");
  await read(undefined, ["claude"]);
  expect(notices).toHaveLength(1);
  const reloaded = new HarnessAccountIdentities(identityPath);
  expect(reloaded.resolve("local", "claude", "work")).toBe(a.label);
  reloaded.deliver((message) => {
    notices.push(message);
    return true;
  });
  expect(notices).toHaveLength(1);
  const refreshed = UsageReportSchema.parse(await (await ownerFetcher.fetch("/v1/usage?refresh=1")).json());
  expect(
    refreshed.accounts.find((account) => account.label === b.label)?.usage?.windows[0]?.usedPercent,
  ).toBe(20);
  expect(
    refreshed.accounts.find((account) => account.label === a.label)?.usage?.windows[0]?.usedPercent,
  ).toBe(82);

  const evidenceDirectory = process.env.VUH2145_EVIDENCE_DIRECTORY;
  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      join(evidenceDirectory, "measured.json"),
      JSON.stringify(
        {
          issue: "VUH-2145",
          proof:
            "scratch HOME; fake native non-secret identity transports, real discovery/persistence/HTTP/CLI/hire refusal",
          before: {
            perHarness: { homes: 4, identities: 2, cards: 4 },
            reason:
              "Previous reader offered implicit default plus three registered homes including a duplicate of default, without identity grouping",
          },
          after: { perHarness: { canonicalHomes: 3, identities: 2, cards: 2 } },
          baseline,
          first,
          api,
          cli: { claude, codex, usage },
          afterResign: after,
          usageAfterResign: refreshed,
          notices,
          nativeQueries: (await readFile(nativeLog, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
          realHomeIdentityQueries: 0,
        },
        null,
        2,
      ) + "\n",
    );
    const apiAfterResign = MachineWorkerAccountsSchema.parse(
      await (await ownerFetcher.fetch("/v1/worker-accounts")).json(),
    );
    await writeFile(
      join(evidenceDirectory, "app-fixture.json"),
      JSON.stringify(
        { accounts: api, usage, afterResign: apiAfterResign, usageAfterResign: refreshed },
        null,
        2,
      ) + "\n",
    );
  }

  // No home now holds A: its alias remains A and cannot silently launch B.
  await writeFile(
    join(home, ".claude", "identity.json"),
    JSON.stringify({ id: "b", email: "b@example.com", used: 20 }),
  );
  const absent = await read(undefined, ["claude"]);
  expect(chooseWorkerAccount("local", "claude", absent, "work")).toMatchObject({
    refused: expect.stringContaining("a@example.com"),
  });
  // A home whose native identity is unavailable cannot bypass the pinned
  // alias merely by retaining its old folder name.
  await writeFile(
    join(home, ".claude-work", "identity.json"),
    JSON.stringify({ id: "b", email: "b@example.com", used: 20, hideIdentity: true }),
  );
  const unidentified = await read(undefined, ["claude"]);
  expect(chooseWorkerAccount("local", "claude", unidentified, "work")).toMatchObject({
    refused: expect.stringContaining("a@example.com"),
  });
  let panes = 0;
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    workerAccounts: (_fleet, harness) => read(undefined, [harness]),
    runner: {
      get: async () => ({}) as never,
      wait: async () => ({}) as never,
      resolveTerminal: async () => undefined,
      createTab: async () => {
        panes++;
        return "w1:p1";
      },
      startAgent: async () => undefined,
    },
  });
  store.workerAccountsReport = read;
  try {
    const accountsTool = captainTools(
      { embodiment: {} } as CaptainDeps,
      {},
      new LaneLog(root),
      "operator",
      undefined,
      undefined,
      store,
    ).find((tool) => tool.name === "worker_accounts")!;
    const toolResult = await accountsTool.execute("accounts-0755", {}, undefined, undefined, {} as never);
    expect(MachineWorkerAccountsSchema.parse(toolResult.details).accounts.length).toBeGreaterThan(0);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o755);
    expect(
      await store.spawnSeat({
        schemaVersion: 1,
        harness: "claude",
        title: "Reader",
        workingDirectory: home,
        account: a.label,
      }),
    ).toMatchObject({
      outcome: "failed",
      reason: "harness_unavailable",
      detail: expect.stringContaining("Sign in"),
    });
    expect(panes).toBe(0);
  } finally {
    store.close();
  }
}, 60_000);

it("migrates an owned private legacy registry once and refuses unsafe registry paths", async () => {
  root = await mkdtemp(join(tmpdir(), "clankie-identity-migration-"));
  const legacy = join(root, "harness-account-identities.json");
  const original = JSON.stringify({
    version: 1,
    machines: {},
    aliases: { '["local","claude","work"]': "account-retained" },
    identities: { "account-retained": "retained@example.com" },
    homes: {},
    notices: [],
  });
  await writeFile(legacy, original, { mode: 0o600 });
  await chmod(root, 0o755);
  const path = harnessAccountIdentityPath(root);
  expect(new HarnessAccountIdentities(path).resolve("local", "claude", "work")).toBe("account-retained");
  expect(await readFile(legacy, "utf8")).toBe(original);
  await writeFile(legacy, "invalid legacy after migration");
  expect(harnessAccountIdentityPath(root)).toBe(path);
  expect(new HarnessAccountIdentities(path).resolve("local", "claude", "work")).toBe("account-retained");
  await rm(path);
  await rm(legacy);
  const target = join(root, "outside.json");
  await writeFile(target, original, { mode: 0o600 });
  await symlink(target, legacy);
  expect(() => harnessAccountIdentityPath(root!)).toThrow();
  await rm(legacy);
  await link(target, legacy);
  expect(() => harnessAccountIdentityPath(root!)).toThrow();
  await rm(legacy);
  const foreign = join(root, "foreign");
  await symlink("/", foreign);
  if (process.getuid && process.getuid() !== 0)
    expect(() => harnessAccountIdentityPath(foreign)).toThrow(/owned and private/u);
  await symlink(target, path);
  expect(() => new HarnessAccountIdentities(path)).toThrow();
  await rm(path);
  await chmod(join(root, "harness-account-identities"), 0o755);
  expect(() => harnessAccountIdentityPath(root!)).toThrow(/owned and private/u);
});

/** VUH-2871: a stopped runtime's in-flight account read must not recreate its removed state directory. */
it("fails an account read aborted during the native probe or after it, without persisting the registry", async () => {
  root = await mkdtemp(join(tmpdir(), "clankie-identity-abort-"));
  vi.stubEnv("HOME", join(root, "home"));
  await mkdir(join(root, "home"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    execution: {
      connections: [
        {
          id: "box",
          kind: "herdr",
          session: "default",
          ssh: { host: "box.invalid", shell: "posix" },
          enabled: true,
          capabilities: ["code"],
        },
      ],
    },
  }));
  const fleet = { id: "box", session: "default", ssh: { host: "box.invalid", shell: "posix" as const } };
  const probe = JSON.stringify({
    schemaVersion: 1,
    accounts: [
      { harness: "claude", label: "default", home: "/h", signedIn: true, identity: "a@example.com" },
    ],
  });
  const gate = () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    return { open, release };
  };
  const reader = (
    stateDir: string,
    signal: AbortSignal | undefined,
    hooks: { shell?: () => Promise<string>; piStatus?: () => Promise<never> },
  ) =>
    createWorkerAccountsReader({
      identityPath: harnessAccountIdentityPath(stateDir),
      settings: () => settings.load(),
      fleet: async () => fleet,
      shell: () => hooks.shell ?? (async () => probe),
      ...(hooks.piStatus ? { piStatus: hooks.piStatus } : {}),
      ...(signal ? { signal } : {}),
    });

  // Control: without an abort the probe's observation is persisted, so the checks below can fail.
  const control = join(root, "control");
  await reader(control, undefined, {})("box", ["claude"]);
  expect((await stat(join(control, "harness-account-identities", "registry.json"))).isFile()).toBe(true);

  // Abort while the remote probe is in flight; the state directory is removed before it answers.
  const probing = join(root, "probing");
  const probeGate = gate();
  const stopProbe = new AbortController();
  const aborted = reader(probing, stopProbe.signal, {
    shell: async () => {
      await probeGate.open;
      return probe;
    },
  })("box", ["claude"]);
  const probeOutcome = aborted.then(
    () => "resolved",
    (error: unknown) => String(error),
  );
  stopProbe.abort(new Error("runtime closed"));
  await rm(probing, { recursive: true, force: true });
  probeGate.release();
  expect(await probeOutcome).toContain("runtime closed");
  await expect(stat(probing)).rejects.toMatchObject({ code: "ENOENT" });

  // Abort after the probe was observed and saved, before the reader delivers notices.
  const delivering = join(root, "delivering");
  const stopDeliver = new AbortController();
  const late = reader(delivering, stopDeliver.signal, {
    piStatus: async () => {
      stopDeliver.abort(new Error("runtime closed"));
      await rm(delivering, { recursive: true, force: true });
      return {
        harness: "pi",
        label: "pi",
        home: "pi",
        signedIn: false,
        usable: false,
        headroom: null,
        reason: "fixture",
      } as never;
    },
  })(undefined, ["pi"]);
  await expect(late).rejects.toThrow("runtime closed");
  await expect(stat(delivering)).rejects.toMatchObject({ code: "ENOENT" });
});
