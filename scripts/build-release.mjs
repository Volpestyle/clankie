import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { build } from "esbuild";

const repoRoot = resolve(import.meta.dirname, "..");
const outputDir = join(repoRoot, "dist");
const archiveName = "clankie-darwin-arm64.tar.gz";
const archivePath = join(outputDir, archiveName);
const checksumPath = `${archivePath}.sha256`;
const nodeVersion = "24.20.0";
const nodeArchiveName = `node-v${nodeVersion}-darwin-arm64.tar.gz`;
const nodeBaseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
const packageMetadata = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const releaseVersion = `v${packageMetadata.version}`;
const entrypoints = [
  "apps/tui/bin/clankie.ts",
  "apps/clankie/src/index.ts",
  "apps/discord-bridge/src/index.ts",
  "apps/discord-bridge/src/presence-runtime-module.ts",
  "apps/discord-user-session/src/index.ts",
  "apps/discord-user-session/src/presence-runtime-module.ts",
  "apps/discord-activity/src/index.ts",
];
const bundleBanner =
  'import { createRequire as __clankieCreateRequire } from "node:module"; ' +
  "const require = __clankieCreateRequire(import.meta.url);";
const licenseName = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu;
const spdxLicenseChecksums = new Map([
  ["Apache-2.0", "c274f80372d90c012937370f0e1f15087d22e308ef98b27cea5dc0d2d088366c"],
  ["BSD-2-Clause", "ffcd6a8c421ee58d9f85b115ee0642805be3b497d2023565739622f044dc11e2"],
  ["LGPL-2.1-or-later", "5749785c8bdefafcb5d798270ed0a967036fe2ca63dcedade1627565dfef81d2"],
  ["MIT", "c3b1b78bc8bd3ea13aa4bc9778442d16560270afa235006d816e5e88cef24db4"],
  ["MPL-2.0", "66c10535a495f4cd8115607e890f8116d657064b98557f660c51e123b3f3fee6"],
]);
const dynamicRuntimePackages = new Set([
  "ajv",
  "ajv-formats",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
]);

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The macOS release must be built on a darwin-arm64 host");
}
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== undefined &&
  process.env.GITHUB_REF_NAME !== releaseVersion
) {
  throw new Error(
    `Release tag ${process.env.GITHUB_REF_NAME} does not match package version ${releaseVersion}`,
  );
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "clankie-release-"));
const releaseRoot = join(temporaryRoot, "clankie");
const metafile = join(temporaryRoot, "esbuild-meta.json");

try {
  await mkdir(releaseRoot, { recursive: true });
  run("pnpm", ["--filter", "@clankie/vox", "build"]);
  const bundle = await build({
    absWorkingDir: repoRoot,
    banner: { js: bundleBanner },
    bundle: true,
    entryPoints: entrypoints,
    format: "esm",
    logLevel: "info",
    metafile: true,
    outbase: ".",
    outdir: releaseRoot,
    platform: "node",
    target: "node24",
  });
  await writeFile(metafile, JSON.stringify(bundle.metafile));

  await copyRuntimeAssets(releaseRoot);
  await copyDynamicRuntimePackages(releaseRoot, metafile);
  await installNodeRuntime(releaseRoot, temporaryRoot);
  await installNativeBinaries(releaseRoot);
  await writeReleaseInventory(releaseRoot, metafile);
  await writeFile(join(releaseRoot, "VERSION"), `${releaseVersion}\n`);
  await writeFile(
    join(releaseRoot, "release.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version: releaseVersion,
        target: "darwin-arm64",
        minimumMacOSVersion: "14.0",
        nodeVersion,
        revision: gitRevision(),
      },
      null,
      2,
    )}\n`,
  );

  await mkdir(outputDir, { recursive: true });
  await rm(archivePath, { force: true });
  await rm(checksumPath, { force: true });
  run("tar", ["-czf", archivePath, "-C", temporaryRoot, "clankie"], {
    ...process.env,
    COPYFILE_DISABLE: "1",
  });
  const digest = await sha256File(archivePath);
  await writeFile(checksumPath, `${digest}  ${archiveName}\n`);
  process.stdout.write(`${archivePath}\n${checksumPath}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: repoRoot, env, stdio: "inherit", maxBuffer: 64 * 1024 * 1024 });
}

function output(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function gitRevision() {
  return output("git", ["rev-parse", "HEAD"]);
}

async function copyRuntimeAssets(targetRoot) {
  const files = [
    ["apps/clankie/src/captain/instructions.md", "apps/clankie/src/instructions.md"],
    ["apps/discord-activity/src/client.html", "apps/discord-activity/src/client.html"],
    ["LICENSE", "LICENSE"],
    ["README.md", "README.md"],
    ["docs/cli.md", "docs/cli.md"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
    ["apps/vox/LICENSE", "apps/vox/LICENSE"],
    ["apps/vox/PROVENANCE.md", "apps/vox/PROVENANCE.md"],
    ["apps/vox/THIRD_PARTY_NOTICES.md", "apps/vox/THIRD_PARTY_NOTICES.md"],
    ["install.sh", "install.sh"],
  ];
  for (const [source, destination] of files) {
    const target = join(targetRoot, destination);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repoRoot, source), target);
  }
  for (const directory of [
    ".agents/skills",
    "integrations/gba-emulator/fixtures",
    "integrations/herdr-plugin",
    "scenarios/emulator",
  ]) {
    await cp(join(repoRoot, directory), join(targetRoot, directory), {
      recursive: true,
      filter: (source) => basename(source) !== ".DS_Store",
    });
  }

  const romdevEntry = output("node", [
    "--input-type=module",
    "--eval",
    'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); process.stdout.write(require.resolve("romdev-platform-gba", { paths: ["integrations/gba-emulator"] }));',
  ]);
  const romdevRoot = await findPackageRoot(romdevEntry);
  if (romdevRoot === undefined) throw new Error(`Cannot locate romdev-platform-gba from ${romdevEntry}`);
  for (const bundleDirectory of ["apps/clankie/src/wasm", "apps/tui/bin/wasm"]) {
    const target = join(targetRoot, bundleDirectory);
    await mkdir(target, { recursive: true });
    await copyFile(join(romdevRoot, "wasm", "mgba_libretro.js"), join(target, "mgba_libretro.js"));
    await copyFile(join(romdevRoot, "wasm", "mgba_libretro.wasm"), join(target, "mgba_libretro.wasm"));
  }
}

async function installNodeRuntime(targetRoot, scratchRoot) {
  const checksums = await fetchText(`${nodeBaseUrl}/SHASUMS256.txt`);
  const expected = checksums
    .split("\n")
    .find((line) => line.endsWith(`  ${nodeArchiveName}`))
    ?.split(/\s+/u)[0];
  if (expected === undefined) throw new Error(`Node checksum is missing for ${nodeArchiveName}`);

  const archive = join(scratchRoot, nodeArchiveName);
  await download(`${nodeBaseUrl}/${nodeArchiveName}`, archive);
  const actual = await sha256File(archive);
  if (actual !== expected)
    throw new Error(`Node checksum mismatch: expected ${expected}, received ${actual}`);

  const extracted = join(scratchRoot, "node");
  await mkdir(extracted);
  run("tar", ["-xzf", archive, "-C", extracted]);
  const distribution = join(extracted, `node-v${nodeVersion}-darwin-arm64`);
  await mkdir(join(targetRoot, "libexec"), { recursive: true });
  await copyFile(join(distribution, "bin", "node"), join(targetRoot, "libexec", "node"));
  await chmod(join(targetRoot, "libexec", "node"), 0o755);
  await mkdir(join(targetRoot, "licenses", "node"), { recursive: true });
  await copyFile(join(distribution, "LICENSE"), join(targetRoot, "licenses", "node", "LICENSE"));
  requireArm64(join(targetRoot, "libexec", "node"));
}

async function copyDynamicRuntimePackages(targetRoot, metafilePath) {
  await mkdir(join(targetRoot, "node_modules"), { recursive: true });
  for (const component of await npmComponents(metafilePath)) {
    if (!dynamicRuntimePackages.has(component.name)) continue;
    await cp(component.root, join(targetRoot, "node_modules", component.name), {
      recursive: true,
      dereference: true,
      filter: (source) => basename(source) !== ".DS_Store",
    });
  }
}

async function installNativeBinaries(targetRoot) {
  const voxTarget = join(targetRoot, "apps", "vox", "target", "release", "clankvox");
  await mkdir(dirname(voxTarget), { recursive: true });
  await copyFile(join(repoRoot, "apps", "vox", "target", "release", "clankvox"), voxTarget);
  await chmod(voxTarget, 0o755);
  run("codesign", ["--force", "--sign", "-", voxTarget]);
  requireArm64(voxTarget);

  const launcher = join(targetRoot, "bin", "clankie");
  await mkdir(dirname(launcher), { recursive: true });
  run("cc", [
    "-arch",
    "arm64",
    "-mmacosx-version-min=14.0",
    "-Os",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(repoRoot, "scripts", "release", "clankie-launcher.c"),
    "-o",
    launcher,
  ]);
  run("codesign", ["--force", "--sign", "-", launcher]);
  requireArm64(launcher);
}

function requireArm64(path) {
  const description = output("file", [path]);
  if (!description.includes("Mach-O 64-bit executable arm64")) {
    throw new Error(`${path} is not a macOS arm64 executable: ${description}`);
  }
}

async function writeReleaseInventory(targetRoot, metafilePath) {
  const npmPackages = await npmComponents(metafilePath);
  const cargoPackages = cargoComponents();
  const components = [
    ...npmPackages.map(({ root: _root, ...component }) => cycloneComponent("npm", component)),
    ...cargoPackages.map(({ root: _root, ...component }) => cycloneComponent("cargo", component)),
    cycloneComponent("generic", {
      name: "node",
      version: nodeVersion,
      license: "MIT",
      homepage: "https://nodejs.org/",
    }),
  ].sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));

  const licenseRows = [];
  for (const component of [...npmPackages, ...cargoPackages]) {
    const ecosystem = npmPackages.includes(component) ? "npm" : "cargo";
    let files = await copyLicenseFiles(
      component.root,
      join(targetRoot, "licenses", ecosystem, safeName(component)),
    );
    if (files.length === 0) files = await includeSpdxLicense(component.license, targetRoot);
    if (files.length === 0)
      throw new Error(`No license text found for ${component.name}@${component.version}`);
    licenseRows.push({ ecosystem, ...component, files });
  }
  licenseRows.push({
    ecosystem: "runtime",
    name: "node",
    version: nodeVersion,
    license: "MIT",
    homepage: "https://nodejs.org/",
    files: ["licenses/node/LICENSE"],
  });

  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: "clankie",
        version: packageMetadata.version,
        licenses: [{ license: { id: "Apache-2.0" } }],
      },
    },
    components,
  };
  await writeFile(join(targetRoot, "SBOM.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

  const report = [
    "# Third-party licenses",
    "",
    "This release inventory is generated from the JavaScript bundle inputs and the locked, reachable Cargo graph.",
    "",
    "| Ecosystem | Component | Version | Declared license | Included texts |",
    "| --- | --- | --- | --- | --- |",
    ...licenseRows
      .sort((left, right) =>
        `${left.ecosystem}:${left.name}`.localeCompare(`${right.ecosystem}:${right.name}`),
      )
      .map(
        (component) =>
          `| ${component.ecosystem} | ${component.name} | ${component.version} | ${component.license} | ${component.files.join("<br>")} |`,
      ),
    "",
  ].join("\n");
  await writeFile(join(targetRoot, "THIRD_PARTY_LICENSES.md"), report);
}

async function npmComponents(metafilePath) {
  const metadata = JSON.parse(await readFile(metafilePath, "utf8"));
  const packages = new Map();
  for (const input of Object.keys(metadata.inputs)) {
    if (!input.includes("node_modules")) continue;
    const root = await findPackageRoot(resolve(repoRoot, input));
    if (root === undefined) throw new Error(`Cannot locate package metadata for bundle input ${input}`);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const component = componentMetadata(manifest, root);
    packages.set(`${component.name}@${component.version}`, component);
  }
  return [...packages.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function findPackageRoot(input) {
  let current = dirname(input);
  for (;;) {
    try {
      const manifestPath = join(current, "package.json");
      if ((await stat(manifestPath)).isFile()) {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (typeof manifest.name === "string" && typeof manifest.version === "string") return current;
      }
    } catch {
      // Keep walking to the package root.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function componentMetadata(manifest, root) {
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`Invalid package metadata at ${root}`);
  }
  const license = typeof manifest.license === "string" ? manifest.license : "UNKNOWN";
  if (license === "UNKNOWN")
    throw new Error(`Package ${manifest.name}@${manifest.version} has no declared license`);
  const homepage =
    typeof manifest.homepage === "string"
      ? manifest.homepage
      : typeof manifest.repository === "string"
        ? manifest.repository
        : typeof manifest.repository?.url === "string"
          ? manifest.repository.url
          : undefined;
  return { name: manifest.name, version: manifest.version, license, homepage, root };
}

function cargoComponents() {
  const metadata = JSON.parse(
    output("cargo", [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      "aarch64-apple-darwin",
      "--manifest-path",
      "apps/vox/Cargo.toml",
    ]),
  );
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const reachable = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    for (const dependency of nodes.get(id)?.dependencies ?? []) pending.push(dependency);
  }
  return [...reachable]
    .map((id) => {
      const pkg = packages.get(id);
      if (pkg === undefined || typeof pkg.license !== "string") {
        throw new Error(`Cargo package ${id} has no declared license`);
      }
      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        homepage: pkg.homepage ?? pkg.repository ?? undefined,
        root: dirname(pkg.manifest_path),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function cycloneComponent(ecosystem, component) {
  const qualifiedName =
    ecosystem === "npm" && component.name.startsWith("@") ? `%40${component.name.slice(1)}` : component.name;
  const purl = `pkg:${ecosystem}/${qualifiedName}@${component.version}`;
  return {
    type: ecosystem === "generic" ? "framework" : "library",
    name: component.name,
    version: component.version,
    "bom-ref": purl,
    purl,
    licenses: [{ license: { name: component.license } }],
    ...(component.homepage === undefined
      ? {}
      : { externalReferences: [{ type: "website", url: component.homepage }] }),
  };
}

function safeName(component) {
  return `${component.name.replaceAll("/", "__")}@${component.version}`;
}

async function copyLicenseFiles(sourceRoot, targetRoot) {
  const copied = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "target") continue;
      const source = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(source);
      } else if (entry.isFile() && licenseName.test(entry.name)) {
        const destination = join(targetRoot, relative(sourceRoot, source));
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
        copied.push(relative(releaseRoot, destination));
      }
    }
  }
  await walk(sourceRoot);
  return copied.sort();
}

async function includeSpdxLicense(license, targetRoot) {
  const alternatives = license.replaceAll(/[()]/gu, "").split(/\s+OR\s+/u);
  const identifiers = [
    ...new Set(
      alternatives.flatMap((alternative) => {
        const required = alternative.split(/\s+AND\s+/u);
        return required.every((identifier) => spdxLicenseChecksums.has(identifier)) ? required : [];
      }),
    ),
  ];
  if (identifiers.length === 0) return [];
  const files = [];
  for (const identifier of identifiers) {
    const target = join(targetRoot, "licenses", "spdx", `${identifier}.txt`);
    try {
      await stat(target);
    } catch {
      await mkdir(dirname(target), { recursive: true });
      const url =
        identifier === "LGPL-2.1-or-later"
          ? `https://raw.githubusercontent.com/spdx/license-list-data/main/text/${identifier}.txt`
          : `https://spdx.org/licenses/${identifier}.txt`;
      await downloadVerified(url, target, spdxLicenseChecksums.get(identifier));
    }
    files.push(relative(targetRoot, target));
  }
  return files;
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return await response.text();
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) throw new Error(`${url} returned ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body),
    await import("node:fs").then(({ createWriteStream }) => createWriteStream(destination)),
  );
}

async function downloadVerified(url, destination, expected) {
  await download(url, destination);
  const actual = await sha256File(destination);
  if (actual !== expected)
    throw new Error(`${url} checksum mismatch: expected ${expected}, received ${actual}`);
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
