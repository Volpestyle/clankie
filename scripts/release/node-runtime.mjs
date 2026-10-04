import { createRequire } from "node:module";
import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export function copyBrowserUseRuntime(repoRoot, targetRoot) {
  return copyRuntime("@browser_use/pi", join(repoRoot, "apps/clankie"), targetRoot);
}

// Mineflayer and its browser viewer load version data and client assets by path.
// Preserve their normal package trees beside the compiled motor entrypoint.
export const minecraftRuntimePackages = [
  "mineflayer",
  "mineflayer-pathfinder",
  "minecraft-data",
  "prismarine-viewer",
  "playwright-core",
  "express",
  "socket.io",
  "vec3",
];

export async function copyMinecraftRuntime(repoRoot, targetRoot) {
  return copyRuntime(minecraftRuntimePackages, join(repoRoot, "integrations/minecraft-mcp"), targetRoot);
}

async function copyRuntime(name, from, targetRoot) {
  const copied = new Map();
  async function copy(name, from, destination) {
    const require = createRequire(join(from, "package.json"));
    let root;
    for (const candidate of require.resolve.paths(`${name}/package.json`) ?? []) {
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
  for (const dependency of Array.isArray(name) ? name : [name]) {
    await copy(dependency, from, join(targetRoot, "node_modules", dependency));
  }
  return [...copied.keys()];
}
