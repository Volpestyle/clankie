/**
 * ADR 0317: Claude hires load the worker from Clankie's own files, so setup and
 * the update refresh only remove what an older setup installed in a profile.
 */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installHarnessBridges } from "../src/harness-install.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** A profile as an older setup left it, and a native CLI that edits it the way Claude does. */
async function legacyProfile(options: { other?: boolean; settings?: string; linkedSettings?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "clankie-claude-removal-"));
  homes.push(home);
  const profile = join(home, ".claude");
  await mkdir(join(profile, "plugins"), { recursive: true });
  const plugins: Record<string, unknown[]> = {
    "clankie-worker@clankie": [{ scope: "user", installPath: join(profile, "plugins", "cache", "worker") }],
    ...(options.other ? { "clankie@clankie": [{ scope: "user", installPath: "/seat" }] } : {}),
  };
  await writeFile(join(profile, "plugins", "installed_plugins.json"), JSON.stringify({ plugins }));
  await writeFile(
    join(profile, "plugins", "known_marketplaces.json"),
    JSON.stringify({ clankie: { source: { source: "directory", path: "/old/clankie" } } }),
  );
  const source = join(home, "dotfiles-settings.json");
  if (options.linkedSettings !== undefined) {
    await writeFile(source, options.linkedSettings);
    await symlink(source, join(profile, "settings.json"));
  } else if (options.settings !== undefined)
    await writeFile(join(profile, "settings.json"), options.settings);
  const calls: string[] = [];
  const execute = async (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "codex") throw new Error("absent");
    expect(env?.CLAUDE_CONFIG_DIR).toBe(profile);
    if (args[0] === "plugin" && args[1] === "uninstall") {
      const registry = JSON.parse(await readFile(join(profile, "plugins", "installed_plugins.json"), "utf8"));
      delete registry.plugins[args[2]!];
      await writeFile(join(profile, "plugins", "installed_plugins.json"), JSON.stringify(registry));
    }
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove")
      await writeFile(join(profile, "plugins", "known_marketplaces.json"), "{}");
    return "";
  };
  return { home, profile, source, calls, execute };
}

it.each([false, true])(
  "removes the old worker copy and an unused marketplace from a plain profile (refresh: %s)",
  async (linkedOnly) => {
    const fixture = await legacyProfile({
      settings: JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": true } }),
    });
    const asked: string[] = [];
    const skills: string[] = [];
    const results = await installHarnessBridges({
      repoRoot: "/fixture/clankie",
      env: { HOME: fixture.home },
      linkedOnly,
      execute: fixture.execute,
      // A Claude-only machine still gets the worker's bundled skills, which each hire loads.
      prepareSkills: async (worker) => {
        skills.push(worker);
      },
      consent: async (_harness, detail) => {
        asked.push(detail);
        return true;
      },
    });
    expect(results.filter((entry) => entry.harness === "claude")).toEqual([
      expect.objectContaining({ profile: fixture.profile, status: "removed" }),
    ]);
    expect(asked).toEqual([
      expect.stringContaining("Remove the old clankie-worker@clankie copy and its clankie marketplace"),
    ]);
    expect(skills).toEqual(["/fixture/clankie/integrations/claude-plugin/worker"]);
    expect(fixture.calls).toEqual(
      expect.arrayContaining([
        "claude plugin uninstall clankie-worker@clankie --scope user",
        "claude plugin marketplace remove clankie",
      ]),
    );
    // Nothing installs or enables a Claude worker any more.
    expect(fixture.calls.some((call) => /plugin (?:install|enable|update)/u.test(call))).toBe(false);
    // A second run finds nothing left to do.
    fixture.calls.length = 0;
    const again = await installHarnessBridges({
      repoRoot: "/fixture/clankie",
      env: { HOME: fixture.home },
      linkedOnly,
      execute: fixture.execute,
      consent: async () => true,
    });
    expect(again.filter((entry) => entry.harness === "claude")).toEqual([]);
    expect(fixture.calls.filter((call) => call.startsWith("claude plugin"))).toEqual([]);
  },
);

it("keeps the marketplace while another Clankie plugin is installed from it", async () => {
  const fixture = await legacyProfile({ other: true, settings: "{}" });
  const results = await installHarnessBridges({
    repoRoot: "/fixture/clankie",
    env: { HOME: fixture.home },
    execute: fixture.execute,
    consent: async () => true,
  });
  expect(results.find((entry) => entry.harness === "claude")?.status).toBe("removed");
  expect(fixture.calls).toContain("claude plugin uninstall clankie-worker@clankie --scope user");
  expect(fixture.calls.some((call) => call.includes("marketplace remove"))).toBe(false);
});

it("leaves a declined profile as it was", async () => {
  const fixture = await legacyProfile({ settings: "{}" });
  const results = await installHarnessBridges({
    repoRoot: "/fixture/clankie",
    env: { HOME: fixture.home },
    execute: fixture.execute,
    consent: async () => false,
  });
  expect(results.find((entry) => entry.harness === "claude")?.status).toBe("declined");
  expect(fixture.calls.filter((call) => call.startsWith("claude plugin"))).toEqual([]);
});

it("names the entries a source-managed settings file must drop, and changes nothing", async () => {
  const linked = JSON.stringify({
    enabledPlugins: { "clankie-worker@clankie": true },
    extraKnownMarketplaces: { clankie: { source: { source: "directory", path: "/old/clankie" } } },
  });
  const fixture = await legacyProfile({ linkedSettings: linked });
  const results = await installHarnessBridges({
    repoRoot: "/fixture/clankie",
    env: { HOME: fixture.home },
    execute: fixture.execute,
    consent: async () => true,
  });
  expect(results.find((entry) => entry.harness === "claude")).toMatchObject({
    status: "source-manager-required",
    detail: expect.stringMatching(
      /enabledPlugins\["clankie-worker@clankie"\] and extraKnownMarketplaces\.clankie/u,
    ),
  });
  expect(fixture.calls.filter((call) => call.startsWith("claude plugin"))).toEqual([]);
  expect(await readFile(fixture.source, "utf8")).toBe(linked);
});

it.each(["untouched", "rewritten"])(
  "clears a source-managed profile's cache only while its settings source stays as it was: %s",
  async (kind) => {
    const linked = JSON.stringify({ model: "owner-choice" });
    const fixture = await legacyProfile({ linkedSettings: linked });
    const results = await installHarnessBridges({
      repoRoot: "/fixture/clankie",
      env: { HOME: fixture.home },
      execute: async (command, args, env) => {
        const output = await fixture.execute(command, args, env);
        if (kind === "rewritten" && args[1] === "uninstall") await writeFile(fixture.source, "{}");
        return output;
      },
      consent: async () => true,
    });
    expect(results.find((entry) => entry.harness === "claude")).toMatchObject(
      kind === "untouched"
        ? { status: "removed" }
        : { status: "failed", detail: expect.stringContaining("changed the Claude settings source") },
    );
    if (kind === "rewritten")
      expect(fixture.calls.some((call) => call.includes("marketplace remove"))).toBe(false);
  },
);

it("asks nothing of a profile an older setup never touched", async () => {
  const home = await mkdtemp(join(tmpdir(), "clankie-claude-removal-clean-"));
  homes.push(home);
  await mkdir(join(home, ".claude"));
  const asked: string[] = [];
  const results = await installHarnessBridges({
    repoRoot: "/fixture/clankie",
    env: { HOME: home },
    execute: async (command) => {
      if (command === "codex") throw new Error("absent");
      return "";
    },
    consent: async (harness) => {
      asked.push(harness);
      return true;
    },
  });
  expect(results.filter((entry) => entry.harness === "claude")).toEqual([]);
  expect(asked).toEqual([]);
});
