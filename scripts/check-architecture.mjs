import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const violations = [];

async function packageDirectories(parent) {
  const entries = await readdir(resolve(root, parent), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(root, parent, entry.name));
}

const directories = [
  ...(await packageDirectories("packages")),
  ...(await packageDirectories("apps")),
  ...(await packageDirectories("integrations")),
];
const manifests = new Map();
for (const directory of directories) {
  try {
    const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
    manifests.set(manifest.name, { directory, manifest });
    for (const script of ["build", "typecheck", "test", "clean"]) {
      if (!manifest.scripts?.[script]) violations.push(`${manifest.name} is missing script ${script}`);
    }
  } catch (error) {
    violations.push(`${directory} has no valid package.json: ${String(error)}`);
  }
}

const workspaceDependencies = (manifest) => ({
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
  ...manifest.devDependencies,
});

function workspaceImports(name) {
  const entry = manifests.get(name);
  if (!entry) return [];
  return Object.keys(workspaceDependencies(entry.manifest)).filter((dependency) =>
    dependency.startsWith("@clankie/"),
  );
}

if (workspaceImports("@clankie/protocol").length > 0)
  violations.push("@clankie/protocol must not depend on workspace packages");

for (const adapter of [
  "@clankie/worker-codex",
  "@clankie/worker-claude",
  "@clankie/worker-pi",
  "@clankie/worker-sim",
]) {
  const forbidden = workspaceImports(adapter).filter((dependency) =>
    ["@clankie/mission-engine", "@clankie/doctrine", "@clankie/credential-broker"].includes(dependency),
  );
  if (forbidden.length)
    violations.push(`${adapter} crosses orchestration/credential boundary: ${forbidden.join(", ")}`);
}

// Graphical command-center (mobile/macOS shells + shared RN UI) lives in the
// private product monorepo Volpestyle/clankie-app — not this agent OS tree.
const uiPackages = ["@clankie/tui", "@clankie/discord-bridge"];
for (const name of uiPackages) {
  if (workspaceImports(name).includes("@clankie/mission-engine")) {
    violations.push(`${name} may not embed the mission engine; it must call the control plane`);
  }
}

const workerDirectories = directories.filter((directory) => basename(directory).startsWith("worker-"));
for (const directory of workerDirectories) {
  const files = await walk(directory);
  for (const path of files.filter((path) => /\.(ts|tsx|js|mjs)$/.test(path))) {
    const source = await readFile(path, "utf8");
    for (const forbidden of [
      "GITHUB_TOKEN",
      "FIGMA_TOKEN",
      "LINEAR_API_KEY",
      "VERCEL_TOKEN",
      "DISCORD_BOT_TOKEN",
    ]) {
      if (source.includes(forbidden))
        violations.push(`${path} references privileged credential ${forbidden}`);
    }
  }
}

// Provider skill mirrors are symlinks to `.agents/skills`; `pnpm skills:check`
// owns that invariant so this walk never has to follow them.

if (violations.length) {
  console.error("Architecture invariant violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed for ${manifests.size} workspaces.`);
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ["node_modules", ".turbo", ".expo", "Pods", "build", "DerivedData", "dist", "coverage"].includes(
        entry.name,
      )
    )
      continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(path)));
    else result.push(path);
  }
  return result;
}
