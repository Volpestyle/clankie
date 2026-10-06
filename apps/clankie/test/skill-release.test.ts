import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile, lstat, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { bundledSkills } from "@clankie/settings";
// @ts-expect-error -- release assembly is plain ESM.
import { copySkillAssets } from "../../../scripts/release/skills.mjs";

import { prepareWorkerSkill } from "../../../integrations/claude-plugin/worker/bin/skill-bundle.mjs";

import { inspectHarnessProfiles } from "../../../integrations/claude-plugin/worker/bin/harness-status.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("loads the canonical Clankie skill through the native Pi parser", async () => {
  const repo = join(import.meta.dirname, "../../..");
  const state = await mkdtemp(join(tmpdir(), "canonical-skill-"));
  roots.push(state);
  const result = loadSkills({
    cwd: state,
    agentDir: state,
    skillPaths: [join(repo, ".agents/skills/clankie")],
    includeDefaults: false,
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.skills.map((skill) => skill.name)).toEqual(["clankie"]);
});

it("assembles only selected skills in all release projections, with no checkout dependencies", async () => {
  const repo = join(import.meta.dirname, "../../..");
  const release = await mkdtemp(join(tmpdir(), "release-skills-"));
  roots.push(release);
  await copySkillAssets(repo, release);
  await cp(join(repo, "vendor/opinionated-skills.json"), join(release, "vendor/opinionated-skills.json"), {
    recursive: true,
  });
  const selected = bundledSkills(repo).map((skill) => skill.name);
  for (const directory of [
    ".agents/skills",
    "integrations/claude-plugin/skills",
    "integrations/codex-plugin/skills",
    "integrations/worker-skills/skills",
  ]) {
    const entries = await readdir(join(release, directory), { withFileTypes: true });
    expect(entries.map((entry) => entry.name).sort()).toEqual(selected);
    expect(entries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink())).toBe(true);
    for (const name of [
      "linear-write",
      "update-review-ethos",
      "mr-link",
      "linear-agent-session",
      "repo-evolution-review",
      "work-tracking",
    ])
      expect(selected).not.toContain(name);
    expect(await readFile(join(release, directory, "lead/SKILL.md"), "utf8")).toBe(
      await readFile(join(repo, "vendor/opinionated-skills/agent/lead/SKILL.md"), "utf8"),
    );
  }
  const canonical = await readFile(join(repo, ".agents/skills/clankie/SKILL.md"), "utf8");
  const resourceCanonical = await readFile(join(repo, ".agents/skills/fleet-resources/SKILL.md"), "utf8");
  // A complete installed release also has no packages/settings TypeScript source.
  const releasedCheck = spawnSync(
    process.execPath,
    [join(release, "integrations/claude-plugin/worker/bin/skill-bundle.mjs")],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(releasedCheck.status, releasedCheck.stderr).toBe(0);

  // Rebuild from canonical target content with neither snapshot nor target builder.
  // Only the repository-side helper's own materializer may be loaded.
  const releaseWorker = join(release, "integrations/claude-plugin/worker");
  for (const name of ["clankie", "fleet-resources"]) {
    await rm(join(releaseWorker, "skills", name), { recursive: true });
    await rm(join(releaseWorker, "skills", `${name}.bundle.json`));
  }
  await rm(join(release, "integrations/codex-plugin/build.mjs"));
  await rm(join(release, "integrations/codex-plugin/skill-materializer.mjs"));
  await expect(prepareWorkerSkill(releaseWorker)).resolves.toBeUndefined();

  for (const directory of [
    ".agents/skills",
    "integrations/claude-plugin/skills",
    "integrations/codex-plugin/skills",
    "integrations/worker-skills/skills",
    "integrations/claude-plugin/worker/skills",
  ]) {
    expect(await readFile(join(release, directory, "clankie/SKILL.md"), "utf8")).toBe(canonical);
    expect((await lstat(join(release, directory, "clankie/SKILL.md"))).isFile()).toBe(true);
    expect(await readFile(join(release, directory, "fleet-resources/SKILL.md"), "utf8")).toBe(
      resourceCanonical,
    );
    expect((await lstat(join(release, directory, "fleet-resources/SKILL.md"))).isFile()).toBe(true);
    const parsed = loadSkills({
      cwd: release,
      agentDir: release,
      skillPaths: [join(release, directory, "clankie"), join(release, directory, "fleet-resources")],
      includeDefaults: false,
    });
    expect(parsed.diagnostics, directory).toEqual([]);
    expect(parsed.skills.map((skill) => skill.name).sort(), directory).toEqual([
      "clankie",
      "fleet-resources",
    ]);
  }
  // Isolate the actual installable worker: no repo source or builder remains.
  const standalone = await mkdtemp(join(tmpdir(), "standalone-worker-"));
  roots.push(standalone);
  const worker = join(standalone, "worker");
  await cp(join(release, "integrations/claude-plugin/worker"), worker, { recursive: true });
  await expect(prepareWorkerSkill(worker)).resolves.toBeUndefined();
  const standaloneSkill = loadSkills({
    cwd: standalone,
    agentDir: standalone,
    skillPaths: [join(worker, "skills")],
    includeDefaults: false,
  });
  expect(standaloneSkill.diagnostics).toEqual([]);
  expect(standaloneSkill.skills.map((skill) => skill.name).sort()).toEqual(["clankie", "fleet-resources"]);
  const companionLink = /\[fleet-resources\]\(([^)]+)\)/u.exec(
    await readFile(join(worker, "skills/clankie/SKILL.md"), "utf8"),
  );
  expect(companionLink).not.toBeNull();
  expect(await readFile(resolve(worker, "skills/clankie", companionLink![1]!), "utf8")).toBe(
    resourceCanonical,
  );
  const nativePackageCheck = spawnSync(process.execPath, [join(worker, "bin/skill-bundle.mjs")], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(nativePackageCheck.status, nativePackageCheck.stderr).toBe(0);

  const profile = join(standalone, ".claude");
  await mkdir(join(profile, "plugins"), { recursive: true });
  await writeFile(
    join(profile, "plugins/installed_plugins.json"),
    JSON.stringify({
      plugins: { "clankie-worker@clankie": [{ scope: "user", installPath: worker }] },
    }),
  );
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": true } }),
  );
  const report = await inspectHarnessProfiles({ env: { HOME: standalone }, execute: async () => "{}" });
  expect(report.claude.find((entry) => entry.profile === profile)).toMatchObject({
    skill: true,
    installed: true,
    enabled: true,
  });

  const companion = join(worker, "skills/fleet-resources/SKILL.md");
  const companionReceipt = join(worker, "skills/fleet-resources.bundle.json");
  const receiptBytes = await readFile(companionReceipt, "utf8");
  await writeFile(companion, "changed resource policy");
  await expect(prepareWorkerSkill(worker)).rejects.toThrow(
    "fleet-resources skill snapshot is missing, stale",
  );
  await writeFile(companion, resourceCanonical);
  await writeFile(companionReceipt, JSON.stringify({ ...JSON.parse(receiptBytes), version: "old" }));
  await expect(prepareWorkerSkill(worker)).rejects.toThrow(
    "fleet-resources skill snapshot is missing, stale",
  );
  await writeFile(companionReceipt, receiptBytes);
  await rm(companion);
  await symlink(join(releaseWorker, "skills/fleet-resources/SKILL.md"), companion);
  await expect(prepareWorkerSkill(worker)).rejects.toThrow("not a regular file");
  await rm(companion);
  await writeFile(companion, resourceCanonical);

  // Updating the helper alone cannot silently accept a legacy clankie-only
  // worker. The existing native installer must refresh its companion snapshot.
  await rm(join(worker, "skills/fleet-resources"), { recursive: true });
  await rm(companionReceipt);
  await expect(prepareWorkerSkill(worker)).rejects.toThrow("fleet-resources skill snapshot is missing");
  await cp(join(releaseWorker, "skills/fleet-resources"), join(worker, "skills/fleet-resources"), {
    recursive: true,
  });
  await cp(join(releaseWorker, "skills/fleet-resources.bundle.json"), companionReceipt);
  await expect(prepareWorkerSkill(worker)).resolves.toBeUndefined();

  await writeFile(join(worker, "skills/clankie/SKILL.md"), "stale or changed content");
  await expect(prepareWorkerSkill(worker)).rejects.toThrow("stale");
  await writeFile(join(worker, "skills/clankie/SKILL.md"), canonical);
  const manifest = join(worker, ".codex-plugin/plugin.json");
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(manifest, JSON.stringify({ ...metadata, version: "old" }));
  await expect(prepareWorkerSkill(worker)).rejects.toThrow("versions differ");
  const claudeManifest = join(worker, ".claude-plugin/plugin.json");
  const claudeMetadata = JSON.parse(await readFile(claudeManifest, "utf8"));
  await writeFile(claudeManifest, JSON.stringify({ ...claudeMetadata, version: "old" }));
  await expect(prepareWorkerSkill(worker)).rejects.toThrow("stale");

  const off = bundledSkills(release, { opinionated: false, exclude: [] });
  expect(off.find((skill) => skill.name === "lead")?.included).toBe(false);
  expect(off.find((skill) => skill.name === "herdr")?.included).toBe(true);
  expect(
    bundledSkills(release, { opinionated: true, exclude: ["reflect"] }).find(
      (skill) => skill.name === "reflect",
    )?.included,
  ).toBe(false);
});
