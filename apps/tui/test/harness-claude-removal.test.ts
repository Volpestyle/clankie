/**
 * ADR 0317: Claude hires load the worker from Clankie's own files, so setup and
 * the update refresh only remove what an older setup installed in a profile.
 */
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectHarnessBridges } from "../src/harness-doctor.ts";
import { installHarnessBridges } from "../src/harness-install.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** A profile as an older setup left it, and a native CLI that edits it the way Claude does. */
async function legacyProfile(
  options: { other?: boolean; settings?: string; linkedSettings?: string; projects?: readonly string[] } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "clankie-claude-removal-"));
  homes.push(home);
  const profile = join(home, ".claude");
  const installPath = join(profile, "plugins", "cache", "worker");
  // The copy's manifest is what doctor reads to call a profile's copy installed.
  await mkdir(join(installPath, ".claude-plugin"), { recursive: true });
  await writeFile(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.2.0" }));
  const plugins: Record<string, unknown[]> = {
    "clankie-worker@clankie": [
      { scope: "user", installPath },
      ...(options.projects ?? []).map((projectPath) => ({ scope: "project", projectPath, installPath })),
    ],
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
  const cwds: (string | undefined)[] = [];
  const execute = async (command: string, args: readonly string[], env?: NodeJS.ProcessEnv, cwd?: string) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "codex") throw new Error("absent");
    expect(env?.CLAUDE_CONFIG_DIR).toBe(profile);
    if (args[0] === "plugin" && args[1] === "uninstall") {
      cwds.push(cwd);
      // Like Claude: user scope drops the user copy; project scope drops only the
      // copy recorded for the project it runs in.
      const registry = JSON.parse(await readFile(join(profile, "plugins", "installed_plugins.json"), "utf8"));
      const scope = args[args.indexOf("--scope") + 1];
      registry.plugins[args[2]!] = registry.plugins[args[2]!].filter(
        (entry: { scope: string; projectPath?: string }) =>
          entry.scope !== scope || (scope === "project" && entry.projectPath !== cwd),
      );
      if (registry.plugins[args[2]!].length === 0) delete registry.plugins[args[2]!];
      await writeFile(join(profile, "plugins", "installed_plugins.json"), JSON.stringify(registry));
    }
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove")
      await writeFile(join(profile, "plugins", "known_marketplaces.json"), "{}");
    return "";
  };
  return { home, profile, source, calls, cwds, execute };
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
    detail: expect.stringMatching(/Remove enabledPlugins\["clankie-worker@clankie"\] there/u),
  });
  expect(fixture.calls.filter((call) => call.startsWith("claude plugin"))).toEqual([]);
  expect(await readFile(fixture.source, "utf8")).toBe(linked);
  // Doctor names that entry rather than asking for an update that would skip the copy.
  expect(await doctorLines(fixture.home, fixture.profile)).toEqual([
    `${fixture.profile} keeps the old clankie-worker 0.2.0 copy while ${await realpath(fixture.source)} enables it: remove enabledPlugins["clankie-worker@clankie"] there through its owner, then clankie update, or clankie harness install --refresh-linked`,
  ]);
});

it("removes the worker but keeps a marketplace a shared settings source still declares", async () => {
  // A named profile whose settings link to the main profile's, which keeps the
  // clankie marketplace for the operator plugin installed there.
  const linked = JSON.stringify({
    enabledPlugins: { "clankie@clankie": false },
    extraKnownMarketplaces: { clankie: { source: { source: "directory", path: "/old/clankie" } } },
  });
  const fixture = await legacyProfile({ linkedSettings: linked });
  const results = await installHarnessBridges({
    repoRoot: "/fixture/clankie",
    env: { HOME: fixture.home },
    execute: fixture.execute,
    consent: async () => true,
  });
  expect(results.find((entry) => entry.harness === "claude")?.status).toBe("removed");
  expect(fixture.calls).toContain("claude plugin uninstall clankie-worker@clankie --scope user");
  expect(fixture.calls.some((call) => call.includes("marketplace remove"))).toBe(false);
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

/** Doctor's remediation lines about this profile's old worker copy. */
async function doctorLines(home: string, profile: string) {
  const report = await inspectHarnessBridges(
    { HOME: home },
    async () => ({ stdout: "", stderr: "" }),
    fetch,
    join(import.meta.dirname, "../../.."),
  );
  return report.remediation.filter((line) => line.includes(profile));
}

it("removes project-scoped copies from inside each project and keeps the ones a project still enables", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-claude-removal-projects-"));
  homes.push(root);
  const plain = join(root, "plain");
  const enabling = join(root, "enabling");
  const gone = join(root, "gone");
  await mkdir(plain);
  await mkdir(join(enabling, ".claude"), { recursive: true });
  const enablingSettings = join(enabling, ".claude", "settings.local.json");
  await writeFile(enablingSettings, JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": true } }));
  const fixture = await legacyProfile({ settings: "{}", projects: [plain, enabling, gone] });
  // Before the cleanup, doctor asks for it and names the project that keeps its copy.
  expect(await doctorLines(fixture.home, fixture.profile)).toEqual([
    `Remove the old clankie-worker 0.2.0 copy from ${fixture.profile}: clankie update, or clankie harness install --refresh-linked`,
    `Project ${enabling} keeps the old clankie-worker 0.2.0 copy from ${fixture.profile} while ${enablingSettings} enables it: remove enabledPlugins["clankie-worker@clankie"] there, then clankie update, or clankie harness install --refresh-linked`,
  ]);
  const asked: { detail: string; projects?: readonly string[] }[] = [];
  const results = await installHarnessBridges({
    repoRoot: "/fixture/clankie",
    env: { HOME: fixture.home },
    execute: fixture.execute,
    consent: async (_harness, detail, context) => {
      asked.push({ detail, ...(context?.projects ? { projects: context.projects } : {}) });
      return true;
    },
  });
  // The consent names the project the removal runs in, and only that one.
  expect(asked).toEqual([
    {
      detail: expect.stringContaining(`from profile ${fixture.profile} and from project ${plain}:`),
      projects: [plain],
    },
  ]);
  expect(asked[0]!.detail).not.toContain(enabling);
  expect(results.find((entry) => entry.harness === "claude")).toMatchObject({
    status: "removed",
    detail: expect.stringContaining(`Kept the project copies that ${enablingSettings} still enables`),
  });
  // Claude removes a project-scoped copy only when run inside that project.
  expect(fixture.calls.filter((call) => call.includes("uninstall"))).toEqual([
    "claude plugin uninstall clankie-worker@clankie --scope user",
    "claude plugin uninstall clankie-worker@clankie --scope project",
  ]);
  expect(fixture.cwds).toEqual([undefined, plain]);
  const registry = JSON.parse(
    await readFile(join(fixture.profile, "plugins", "installed_plugins.json"), "utf8"),
  );
  expect(
    registry.plugins["clankie-worker@clankie"].map((entry: { projectPath?: string }) => entry.projectPath),
  ).toEqual([enabling, gone]);
  // After it, doctor no longer asks for an update; it names only the entry the
  // project's owner has to drop. A missing project has nothing to clear.
  expect(await doctorLines(fixture.home, fixture.profile)).toEqual([
    `Project ${enabling} keeps the old clankie-worker 0.2.0 copy from ${fixture.profile} while ${enablingSettings} enables it: remove enabledPlugins["clankie-worker@clankie"] there, then clankie update, or clankie harness install --refresh-linked`,
  ]);
  // And a second cleanup has nothing to ask.
  asked.length = 0;
  const again = await installHarnessBridges({
    repoRoot: "/fixture/clankie",
    env: { HOME: fixture.home },
    execute: fixture.execute,
    consent: async () => {
      asked.push({ detail: "asked" });
      return true;
    },
  });
  expect(again.filter((entry) => entry.harness === "claude")).toEqual([]);
  expect(asked).toEqual([]);
});

it("names a project settings file it cannot read instead of passing it for one that enables nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-claude-removal-unreadable-"));
  homes.push(root);
  const locked = join(root, "locked");
  await mkdir(join(locked, ".claude"), { recursive: true });
  const settings = join(locked, ".claude", "settings.json");
  await writeFile(settings, JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": true } }));
  await chmod(settings, 0o000);
  try {
    const fixture = await legacyProfile({ settings: "{}", projects: [locked] });
    const lines = await doctorLines(fixture.home, fixture.profile);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Could not read what keeps the old clankie-worker 0\.2\.0 copy in .*: EACCES/u);
    // The cleanup refuses too, rather than uninstalling a copy that file may still enable.
    await expect(
      installHarnessBridges({
        repoRoot: "/fixture/clankie",
        env: { HOME: fixture.home },
        execute: fixture.execute,
        consent: async () => true,
      }),
    ).rejects.toThrow(/EACCES/u);
    expect(fixture.calls.filter((call) => call.includes("uninstall"))).toEqual([]);
  } finally {
    await chmod(settings, 0o600);
  }
});
