import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SettingsStore } from "@clankie/settings";
import { installHarnessBridges } from "../src/harness-install.ts";
import { refreshLinkedHarnesses } from "../src/harness-refresh.ts";
import { inspectHarnessProfiles } from "../../../integrations/claude-plugin/worker/bin/harness-status.mjs";
import { createRuntimeUpdateRoutes } from "../../clankie/src/runtime-update-routes.ts";
import { prepareFleet } from "../../clankie/src/fleet-prepare.ts";

const exec = promisify(execFile);
// Real native managers, isolated homes, no network/service/restarts. Opt in on a machine with both harnesses.
it.skipIf(process.env.NATIVE_HARNESS_FIXTURES !== "1")(
  "refreshes native linked profiles through the API and remote preparation without enrolling or restarting",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-linked-")));
    const home = join(root, "home"),
      source = join(root, "old", "integrations", "claude-plugin"),
      target = join(root, "new", "integrations", "claude-plugin");
    const token = `clankie_op_${"f".repeat(43)}`;
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CLANKIE_SETTINGS_FILE: join(home, "settings.json"),
      CLANKIE_OPERATOR_TOKEN: token,
    };
    try {
      await mkdir(env.CODEX_HOME, { recursive: true });
      for (const [market, version] of [
        [source, "0.6.1"],
        [target, "0.6.2"],
      ]) {
        await cp(join(import.meta.dirname, "../../../integrations/claude-plugin"), market!, {
          recursive: true,
        });
        for (const path of [
          "worker/.claude-plugin/plugin.json",
          "worker/.codex-plugin/plugin.json",
          "worker/skills/clankie.bundle.json",
        ]) {
          const file = join(market!, path),
            value = JSON.parse(await readFile(file, "utf8"));
          await writeFile(file, JSON.stringify({ ...value, version }));
        }
      }
      const initial = await installHarnessBridges({
        env,
        marketplaceRoot: source,
        consent: async () => true,
      });
      expect(initial.map((entry) => entry.status)).toEqual(["installed", "installed"]);
      // The owner account and an alias have separate native caches but share settings.
      const alias = join(home, ".claude-james");
      await mkdir(alias);
      await cp(join(home, ".claude/plugins"), join(alias, "plugins"), { recursive: true });
      await symlink(join(home, ".claude/settings.json"), join(alias, "settings.json"));
      const untouched = join(home, ".claude-unlinked");
      await mkdir(untouched);
      await writeFile(join(untouched, "settings.json"), "{}\n");
      const extraCodex = join(home, "custom-codex");
      await mkdir(extraCodex);
      expect(
        (
          await installHarnessBridges({
            env: { ...env, CODEX_HOME: extraCodex },
            marketplaceRoot: source,
            consent: async (harness) => harness === "codex",
          })
        ).find((entry) => entry.harness === "codex")?.status,
      ).toBe("installed");
      const settings = new SettingsStore(env.CLANKIE_SETTINGS_FILE);
      await settings.update((current) => ({
        ...current,
        codexAccounts: [{ label: "codex2", home: extraCodex }],
      }));
      // API uses the same production coordinator and real native installers.
      let announcedVersion: string | undefined;
      const app = createRuntimeUpdateRoutes({
        settings,
        authorize: async (request) =>
          request.headers.get("authorization") === `Bearer ${token}`
            ? { current: () => true, guard: async () => {} }
            : undefined,
        pluginVersionInstalled: (version) => {
          announcedVersion = version;
        },
        refreshHarnesses: (authority) =>
          refreshLinkedHarnesses({
            env,
            settings,
            authorizeSetup: authority.authorizeSetup,
            repoRoot: join(root, "new"),
            fleets: [],
            host: "http://fixture",
            fetchImpl: async (input, init) => app.fetch(new Request(String(input), init)),
          }),
      });
      expect((await app.request("/v1/harness-refresh", { method: "POST" })).status).toBe(403);
      const response = await app.request("/v1/harness-refresh", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ workingDirectory: join(root, "new"), ownerApproved: true }),
      });
      const result = await response.json();
      expect(response.status).toBe(200);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.notices.state).toBe("announced");
      expect(announcedVersion).toBe("0.6.2");
      expect(result.local.map((entry: { profile: string }) => entry.profile).sort()).toEqual(
        [join(home, ".claude"), alias, env.CODEX_HOME, extraCodex].sort(),
      );
      expect(await readFile(join(untouched, "settings.json"), "utf8")).toBe("{}\n");
      expect(await realpath(join(alias, "settings.json"))).toBe(
        await realpath(join(home, ".claude/settings.json")),
      );
      const doctor = await inspectHarnessProfiles({ env, expectedVersion: "0.6.2" });
      expect(doctor.claude.filter((entry) => entry.installed).map((entry) => entry.versionMatches)).toEqual([
        true,
        true,
      ]);
      expect(doctor.codex).toMatchObject({
        versionMatches: true,
        bridge: true,
        identityForwarding: true,
        skill: true,
      });
      // Execute the actual remote POSIX command stream locally with this fixture's home.
      const commands: string[] = [];
      const remote = await prepareFleet(
        { id: "fixture", session: "unused", ssh: { host: "fixture", shell: "posix" } },
        {
          linkedOnly: true,
          workerPluginDir: join(target, "worker"),
          shell: async (command, timeout) => {
            commands.push(command);
            return (await exec("sh", ["-c", command], { env, timeout })).stdout;
          },
          copy: async (path, destination) => {
            await cp(path, join(home, destination), { recursive: true });
          },
        },
      );
      expect(
        Array.isArray(remote.installations) &&
          remote.installations.every((entry) => entry.status === "updated"),
        JSON.stringify(remote),
      ).toBe(true);
      expect(remote.policy.changed).toBe(false);
      expect(commands.some((command) => /managed-settings|restart|send-keys/u.test(command))).toBe(false);
      expect((await inspectHarnessProfiles({ env, expectedVersion: "0.6.2" })).codex.versionMatches).toBe(
        true,
      );
      // The owning source hook uses the real native manager, regenerates its source, and restores its link.
      const managedConfig = join(env.CODEX_HOME, "config.toml"),
        configSource = join(root, "owner-config.toml");
      await rename(managedConfig, configSource);
      await writeFile(configSource, 'model = "fixture-owner"\n' + (await readFile(configSource, "utf8")));
      await symlink(configSource, managedConfig);
      const sourceScript = join(root, "source-setup.mjs"),
        sourceLog = join(root, "source-runs.txt");
      await writeFile(
        sourceScript,
        `
import { appendFile, copyFile, realpath, readlink, unlink, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const config = join(process.env.CODEX_HOME, 'config.toml');
const source = await realpath(config), link = await readlink(config);
const native = process.env.CLANKIE_CODEX_NATIVE_EXECUTABLE, marketplace = process.env.CLANKIE_CODEX_WORKER_MARKETPLACE;
await unlink(config); await copyFile(source, config);
try {
  const list = JSON.parse(execFileSync(native, ['plugin', 'marketplace', 'list', '--json'], {encoding: 'utf8'}));
  const prior = list.marketplaces.find(entry => entry.name === 'clankie-fleet');
  if (prior && await realpath(prior.root) !== await realpath(marketplace))
    execFileSync(native, ['plugin', 'marketplace', 'remove', 'clankie-fleet', '--json']);
  execFileSync(native, ['plugin', 'marketplace', 'add', marketplace]);
  execFileSync(native, ['plugin', 'add', 'clankie-worker@clankie-fleet', '--json']);
  await copyFile(config, source);
  await appendFile(${JSON.stringify(sourceLog)}, 'completed\\n');
} finally { await unlink(config); await symlink(link, config); }
`,
      );
      const approved = await installHarnessBridges({
        env,
        marketplaceRoot: target,
        codexSourceSetup: { command: process.execPath, args: [sourceScript] },
        consent: async (harness) => harness === "codex",
      });
      expect(approved.find((entry) => entry.harness === "codex")?.status, JSON.stringify(approved)).toBe(
        "source-setup-completed",
      );
      for (const path of [
        "worker/.claude-plugin/plugin.json",
        "worker/.codex-plugin/plugin.json",
        "worker/skills/clankie.bundle.json",
      ]) {
        const file = join(target, path),
          value = JSON.parse(await readFile(file, "utf8"));
        await writeFile(file, JSON.stringify({ ...value, version: "0.6.3" }));
      }
      const reused = await installHarnessBridges({
        env,
        marketplaceRoot: target,
        linkedOnly: true,
        consent: async () => true,
      });
      expect(reused.find((entry) => entry.profile === env.CODEX_HOME)?.status, JSON.stringify(reused)).toBe(
        "source-setup-completed",
      );
      expect(await realpath(managedConfig)).toBe(configSource);
      expect(await readFile(configSource, "utf8")).toContain('model = "fixture-owner"');
      expect((await inspectHarnessProfiles({ env, expectedVersion: "0.6.3" })).codex.versionMatches).toBe(
        true,
      );
      const client = new Client({ name: "fixture", version: "1" });
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              join(env.CODEX_HOME, "plugins/cache/clankie-fleet/clankie-worker/0.6.3/bin/fleet-mcp.mjs"),
            ],
            env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, CODEX_HOME: env.CODEX_HOME },
            stderr: "pipe",
          }),
        );
        expect(client.getServerVersion()).toMatchObject({ name: "clankie-worker", version: "0.6.3" });
      } finally {
        await client.close();
      }
      expect((await readFile(sourceLog, "utf8")).trim().split("\n")).toHaveLength(2);
      const inactiveConfig = join(extraCodex, "config.toml");
      const disabled = (await readFile(inactiveConfig, "utf8")).replaceAll(
        "enabled = true",
        "enabled = false",
      );
      await writeFile(inactiveConfig, disabled);
      expect(
        (await inspectHarnessProfiles({ env: { ...env, CODEX_HOME: extraCodex }, expectedVersion: "0.6.3" }))
          .codex.enabled,
      ).toBe(false);
      const inactive = await installHarnessBridges({
        env,
        marketplaceRoot: target,
        linkedOnly: true,
        consent: async () => true,
      });
      expect(inactive.find((entry) => entry.profile === extraCodex)?.status).toBe("declined");
      expect(await readFile(inactiveConfig, "utf8")).toBe(disabled);
      const sourceRunsBeforeRetarget = await readFile(sourceLog, "utf8");
      const changedSource = join(root, "changed-source.toml");
      await cp(configSource, changedSource);
      await rm(managedConfig);
      await symlink(changedSource, managedConfig);
      const refused = await installHarnessBridges({
        env,
        marketplaceRoot: target,
        linkedOnly: true,
        consent: async () => true,
      });
      expect(refused.find((entry) => entry.profile === env.CODEX_HOME)?.status).toBe(
        "source-manager-required",
      );
      expect(await readFile(sourceLog, "utf8")).toBe(sourceRunsBeforeRetarget);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it("leaves absent unlinked harnesses alone and reports an absent already-linked harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-absent-links-"));
  try {
    const env = { HOME: root, USERPROFILE: root, PATH: join(root, "no-executables") };
    expect(
      await installHarnessBridges({ env, repoRoot: root, linkedOnly: true, consent: async () => true }),
    ).toEqual([]);
    await mkdir(join(root, ".codex"));
    await writeFile(
      join(root, ".codex/config.toml"),
      '[mcp_servers.clankie]\ncommand = "clankie"\nargs = ["mcp", "--fleet"]\n',
    );
    expect(
      await installHarnessBridges({ env, repoRoot: root, linkedOnly: true, consent: async () => true }),
    ).toMatchObject([{ harness: "codex", status: "absent" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
