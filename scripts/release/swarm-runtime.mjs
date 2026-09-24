import { createRequire } from "node:module";
import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

// Swarm launches sibling Node entrypoints, so preserve its package graph instead
// of folding it into Clankie's bundle. Each real package is copied exactly once.
export async function copySwarmRuntime(repoRoot, targetRoot) {
  const copied = new Map();
  async function copy(name, from, destination) {
    const require = createRequire(join(from, "package.json"));
    let root;
    for (const candidate of require.resolve.paths(name) ?? []) {
      try {
        root = await realpath(join(candidate, name));
        break;
      } catch {
        /* Next resolution root. */
      }
    }
    if (!root) throw new Error(`Cannot resolve release dependency ${name} from ${from}`);
    await mkdir(dirname(destination), { recursive: true });
    const previous = copied.get(root);
    if (previous) {
      await symlink(relative(dirname(destination), previous), destination);
      return;
    }
    copied.set(root, destination);
    await cp(root, destination, {
      recursive: true,
      dereference: true,
      filter: (source) => !["node_modules", ".DS_Store"].includes(basename(source)),
    });
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await copy(dependency, root, join(destination, "node_modules", dependency));
    }
  }
  for (const name of ["swarm-mcp", "@volpestyle/lead-skills"]) {
    await copy(name, join(repoRoot, "packages/swarm"), join(targetRoot, "node_modules", name));
  }
  return [...copied.keys()];
}
