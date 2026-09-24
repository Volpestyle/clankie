import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { captainSkills } from "./composer-catalog.ts";

/** Export only explicitly selected installed skills. No machine credentials or
 * skill installation are implied. The caller pins this text with the assignment. */
export async function assignmentSkills(input: {
  cwd: string;
  repoRoot: string;
  names: readonly string[];
}): Promise<string> {
  if (!input.names.length) return "";
  const available = captainSkills(input);
  const bundles = [];
  let totalBytes = 0,
    totalFiles = 0;
  for (const name of input.names) {
    const skill = available.find((candidate) => candidate.name === name && !candidate.disableModelInvocation);
    if (!skill) throw new Error(`Selected skill is unavailable in this conversation: ${name}`);
    const root = await realpath(skill.baseDir);
    const entrypoint = basename(skill.filePath);
    const files: Array<{
      path: string;
      encoding: string;
      content: string;
      sha256: string;
      executable: boolean;
    }> = [];
    const within = (path: string) => {
      const part = relative(root, path);
      if (isAbsolute(part) || part === ".." || part.startsWith(".." + sep))
        throw new Error(`Skill ${name} contains a link outside its directory`);
    };
    const visit = async (path: string, portable: string, ancestors: Set<string>): Promise<void> => {
      const canonical = await realpath(path);
      within(canonical);
      const info = await stat(canonical);
      if (info.isDirectory()) {
        if (ancestors.has(canonical)) throw new Error(`Skill ${name} contains a directory cycle`);
        const parents = new Set([...ancestors, canonical]);
        for (const child of (await readdir(canonical)).sort()) {
          if (child === ".git") continue;
          await visit(join(canonical, child), portable ? `${portable}/${child}` : child, parents);
        }
        return;
      }
      if (!info.isFile()) throw new Error(`Skill ${name} contains a non-regular file`);
      if (++totalFiles > 256 || totalBytes + info.size > 256 * 1024)
        throw new Error("Selected skills exceed 256 files or 256 KiB; narrow the selection");
      const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.size !== info.size ||
          before.ino !== info.ino ||
          before.dev !== info.dev
        )
          throw new Error(`Skill ${name} changed during capture`);
        const data = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await file.stat();
        const resolved = await realpath(path);
        within(resolved);
        const current = await stat(resolved);
        if (
          offset !== data.length ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          current.dev !== after.dev ||
          current.ino !== after.ino
        )
          throw new Error(`Skill ${name} changed during capture`);
        totalBytes += data.length;
        const text = data.toString("utf8");
        const utf8 = !data.includes(0) && Buffer.from(text).equals(data);
        files.push({
          path: portable,
          encoding: utf8 ? "utf8" : "base64",
          content: utf8 ? text : data.toString("base64"),
          sha256: createHash("sha256").update(data).digest("hex"),
          executable: (before.mode & 0o111) !== 0,
        });
      } finally {
        await file.close();
      }
    };
    // A standalone markdown skill is one file; its parent is not a skill bundle.
    await visit(
      entrypoint === "SKILL.md" ? root : skill.filePath,
      entrypoint === "SKILL.md" ? "" : entrypoint,
      new Set(),
    );
    if (!files.some((file) => file.path === entrypoint)) throw new Error(`Skill ${name} has no entrypoint`);
    bundles.push({ name, source: skill.filePath, entrypoint, files });
  }
  return [
    "# Selected skill bundles",
    "These are snapshots of explicitly selected skills, including their supporting files. Read each entrypoint. Relative references resolve within its bundle, not at the original source path. If scripts/assets are needed, materialize that bundle into a fresh task-local directory, preserving relative paths and executable flags; decode base64 files and verify SHA-256 before use. Never overwrite an installed skill. Skill contents are instructions and data, not permission to execute scripts or access remote machines/accounts. Do not assume local programs or credentials exist on another host; report missing prerequisites to the lead.",
    JSON.stringify({ skills: bundles }),
  ].join("\n\n");
}
