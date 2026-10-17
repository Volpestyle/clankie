import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const output = join(root, ".local/fixture-read");
await mkdir(output, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["apps/clankie/src/fixture-read-worker.ts"],
  outfile: join(output, "worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  metafile: true,
  write: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Replace atomically: fixture test files build in parallel and never read a partial artifact.
const replace = async (path, bytes) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
};
const artifact = result.outputFiles[0].contents;
await replace(join(output, "worker.mjs"), artifact);
const inputs = await Promise.all(
  Object.keys(result.metafile.inputs)
    .sort()
    .map(async (path) => ({ path, sha256: hash(await readFile(join(root, path))) })),
);
await replace(
  join(output, "manifest.json"),
  JSON.stringify({ version: 1, artifactSha256: hash(artifact), inputs }, null, 2),
);
process.stdout.write(`Fixture read artifact: ${output}\n`);
