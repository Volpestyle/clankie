import { existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  bundledSkills,
  clankieSkillRoots,
  mergedLeadershipSkills,
  projectSkillPlugin,
  type SkillsSettings,
} from "@clankie/settings";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per-launch discovery, without installing skills in the owner's harness. */
export async function workerSkills(
  harness: string,
  repoRoot: string,
  stateDir: string,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  settings: SkillsSettings = { opinionated: true, exclude: [] },
  cwd?: string,
): Promise<{ args: readonly string[]; env?: Readonly<Record<string, string>> }> {
  const catalog = bundledSkills(repoRoot, settings);
  if (harness === "claude") {
    const plugin = await projectSkillPlugin(
      join(repoRoot, "integrations", "worker-skills"),
      stateDir,
      catalog,
    );
    return { args: ["--plugin-dir", plugin] };
  }
  if (harness === "pi") {
    const paths = clankieSkillRoots({
      repoRoot,
      agentDir: getAgentDir(),
      home: homedir(),
      skills: settings,
      ...(cwd === undefined ? {} : { cwd }),
    }).filter(existsSync);
    return { args: ["--no-skills", ...paths.flatMap((path) => ["--skill", path])] };
  }
  if (harness !== "codex") return { args: [] };

  // Codex has no CLI extra-roots flag. An overlay owns its config and skills;
  // existing auth, plugins and transcript stores still resolve to the owner's
  // files. Copy configuration so a worker's config writes cannot edit theirs.
  const overlays = join(stateDir, "worker-codex");
  await mkdir(overlays, { recursive: true, mode: 0o700 });
  const overlay = await realpath(await mkdtemp(join(overlays, "seat-")));
  await mkdir(join(overlay, "skills"));
  // Even a newly signed-in account writes rollouts back into its own home.
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  for (const entry of await readdir(codexHome, { withFileTypes: true })) {
    // App-server rejects symlinked control directories and workers must not
    // borrow the owner's shared daemon sockets (VUH-1398, VUH-1459).
    if (entry.name === "skills" || entry.name === "app-server-control") continue;
    const source = join(codexHome, entry.name);
    const destination = join(overlay, entry.name);
    if (entry.name.endsWith(".toml") || entry.name === "hooks.json") {
      await cp(source, destination, { dereference: true });
      if (entry.name.endsWith(".toml")) {
        // Hook trust is keyed by hooks.json's location. Carry the owner's
        // existing hash to the identical copied file, never invent a hash or
        // bypass review of an untrusted/changed hook.
        // Accounts can share one config whose keys name another home's
        // hooks.json, so match by the file the copy came from.
        let config = await readFile(destination, "utf8");
        const hooks = await realpath(join(codexHome, "hooks.json")).catch(() => undefined);
        const keyed = new Set(
          [...config.matchAll(/hooks\.state\."([^"]*\/hooks\.json):/gu)].map((match) => match[1]!),
        );
        keyed.add(join(codexHome, "hooks.json"));
        for (const path of keyed) {
          const same =
            path === join(codexHome, "hooks.json") ||
            (hooks !== undefined && (await realpath(path).catch(() => undefined)) === hooks);
          if (same) config = config.replaceAll(`${path}:`, `${join(overlay, "hooks.json")}:`);
        }
        await writeFile(destination, config);
      }
    } else {
      await symlink(source, destination);
    }
  }
  // Keep personal tool skills (and system skills), with bundle names winning.
  const bundled: readonly string[] = [...catalog.map((skill) => skill.name), ...mergedLeadershipSkills];
  for (const skill of catalog) {
    if (skill.included) await symlink(skill.path, join(overlay, "skills", skill.name));
  }
  for (const name of await readdir(join(codexHome, "skills")).catch(() => [])) {
    if (!bundled.includes(name))
      await symlink(join(codexHome, "skills", name), join(overlay, "skills", name));
  }
  return { args: [], env: { CODEX_HOME: overlay } };
}
