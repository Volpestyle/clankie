import { createHash } from "node:crypto";
import { access, lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Build from the checkout when present; installed packages need only their snapshot. */
export async function prepareWorkerSkill(workerRoot) {
  const sourceRoot = resolve(workerRoot, "../../..");
  const version = JSON.parse(await readFile(join(workerRoot, ".claude-plugin/plugin.json"), "utf8")).version;
  const codexVersion = JSON.parse(
    await readFile(join(workerRoot, ".codex-plugin/plugin.json"), "utf8"),
  ).version;
  if (typeof version !== "string" || version.length === 0 || version !== codexVersion)
    throw new Error("Worker plugin versions differ or are missing; rebuild both packages");
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const builder = new URL("../../../codex-plugin/skill-materializer.mjs", import.meta.url);
  // Clankie's resource instructions are a relative companion link, so both
  // authored skills must survive an isolated native worker installation.
  for (const name of ["clankie", "fleet-resources"]) {
    const source = join(sourceRoot, ".agents/skills", name);
    const target = join(workerRoot, "skills", name);
    const receipt = join(workerRoot, "skills", `${name}.bundle.json`);
    if (
      await Promise.all([access(join(source, "SKILL.md")), access(fileURLToPath(builder))]).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    ) {
      // Always use this module's trusted builder, never a caller-selected one.
      // An installed standalone worker has neither builder nor canonical source.
      const { materializeSkill } = await import(builder.href);
      materializeSkill(source, target);
      await writeFile(
        receipt,
        JSON.stringify({ version, sha256: hash(await readFile(join(source, "SKILL.md"))) }) + "\n",
      );
    }
    const file = join(target, "SKILL.md");
    try {
      const metadata = JSON.parse(await readFile(receipt, "utf8"));
      if (
        !(await lstat(target)).isDirectory() ||
        (await lstat(target)).isSymbolicLink() ||
        !(await lstat(file)).isFile() ||
        (await lstat(file)).isSymbolicLink() ||
        metadata.version !== version ||
        metadata.sha256 !== hash(await readFile(file))
      )
        throw new Error("Invalid worker skill snapshot");
    } catch (cause) {
      throw new Error(
        `Worker ${name} skill snapshot is missing, stale or not a regular file; rebuild the worker package`,
        { cause },
      );
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await prepareWorkerSkill(resolve(import.meta.dirname, ".."));
