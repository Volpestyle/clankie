import { createHash } from "node:crypto";
import { access, lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Build from the checkout when present; installed packages need only their snapshot. */
export async function prepareWorkerSkill(workerRoot) {
  const sourceRoot = resolve(workerRoot, "../../..");
  const source = join(sourceRoot, ".agents/skills/clankie");
  const target = join(workerRoot, "skills/clankie");
  const receipt = join(workerRoot, "skills/clankie.bundle.json");
  const version = JSON.parse(await readFile(join(workerRoot, ".claude-plugin/plugin.json"), "utf8")).version;
  const codexVersion = JSON.parse(
    await readFile(join(workerRoot, ".codex-plugin/plugin.json"), "utf8"),
  ).version;
  if (typeof version !== "string" || version.length === 0 || version !== codexVersion)
    throw new Error("Worker plugin versions differ or are missing; rebuild both packages");
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  if (
    await Promise.all([
      access(join(source, "SKILL.md")),
      access(join(sourceRoot, "integrations/codex-plugin/build.mjs")),
    ]).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  ) {
    // Release assembly has the source skill but not its builder. The builder
    // belongs to this module's repository/package, never to a remote runtime.
    const builder = new URL("../../../codex-plugin/build.mjs", import.meta.url);
    const { materializeSkill } = await import(builder.href);
    materializeSkill(source, target);
    await writeFile(
      receipt,
      JSON.stringify({ version, sha256: hash(await readFile(join(source, "SKILL.md"))) }) + "\n",
    );
  }
  const file = join(target, "SKILL.md");
  const metadata = JSON.parse(await readFile(receipt, "utf8"));
  if (
    !(await lstat(target)).isDirectory() ||
    (await lstat(target)).isSymbolicLink() ||
    !(await lstat(file)).isFile() ||
    (await lstat(file)).isSymbolicLink() ||
    metadata.version !== version ||
    metadata.sha256 !== hash(await readFile(file))
  )
    throw new Error(
      "Worker clankie skill snapshot is missing, stale or not a regular file; rebuild the worker package",
    );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await prepareWorkerSkill(resolve(import.meta.dirname, ".."));
