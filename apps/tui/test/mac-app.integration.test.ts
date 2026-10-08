import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { prepareMacApp } from "../bin/mac-app.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "clankie-mac-app-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const install = join(dir, "install"),
    apps = join(dir, "Applications"),
    release = join(dir, "release");
  await mkdir(install);
  await mkdir(join(release, "scripts/release"), { recursive: true });
  const app = join(dir, "source/Clankie.app/Contents");
  await mkdir(join(app, "MacOS"), { recursive: true });
  await writeFile(
    join(app, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Clankie</string></dict></plist>",
  );
  await writeFile(join(app, "MacOS/Clankie"), "#!/bin/sh\necho fixture\n");
  await chmod(join(app, "MacOS/Clankie"), 0o755);
  const archive = join(dir, "app.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(dir, "source"), "Clankie.app"]);
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let downloads = 0;
  const server = createServer((_, response) => {
    downloads++;
    response.end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/app.tar.gz`;
  const pin = async (version = "v1.0.0", digest = sha256) =>
    writeFile(
      join(release, "scripts/release/mac-app.json"),
      JSON.stringify({ schemaVersion: 1, app: { version, sha256: digest, url } }),
    );
  await pin();
  const prepare = (target = "darwin-arm64") =>
    prepareMacApp(release, install, { target, applicationsDirectory: apps });
  return { dir, install, apps, release, pin, prepare, downloads: () => downloads };
}

it("installs a fixture bundle, skips unchanged pins, and rolls back a changed pin", async () => {
  const f = await fixture();
  const first = (await f.prepare())!;
  first.activate();
  first.finish();
  expect(await readFile(join(first.path, "Contents/MacOS/Clankie"), "utf8")).toContain("fixture");
  const marker = await readFile(join(f.install, "app-install.json"), "utf8");
  const same = (await f.prepare())!;
  expect(same.changed).toBe(false);
  expect(f.downloads()).toBe(1);
  await f.pin("v1.1.0");
  const changed = (await f.prepare())!;
  expect(changed.changed).toBe(true);
  changed.activate();
  changed.rollback();
  expect(await readFile(join(f.install, "app-install.json"), "utf8")).toBe(marker);
  expect(await readFile(join(first.path, "Contents/MacOS/Clankie"), "utf8")).toContain("fixture");
});

it("checksum failure, opt-out, Linux, and unmanaged destinations retain the app", async () => {
  const f = await fixture();
  const first = (await f.prepare())!;
  first.activate();
  first.finish();
  const marker = await readFile(join(f.install, "app-install.json"), "utf8");
  await f.pin("v1.1.0", "0".repeat(64));
  await expect(f.prepare()).rejects.toThrow("checksum");
  expect(await readFile(join(f.install, "app-install.json"), "utf8")).toBe(marker);
  expect(await f.prepare("linux-arm64")).toBeNull();
  await writeFile(join(f.install, "app-policy.json"), '{"disabled":true}');
  expect(await f.prepare()).toBeNull();
  expect(f.downloads()).toBe(2);
  await rm(join(f.install, "app-policy.json"));
  await rm(join(f.install, "app-install.json"));
  await expect(f.prepare()).rejects.toThrow("unmanaged");
  expect(await readFile(join(first.path, "Contents/MacOS/Clankie"), "utf8")).toContain("fixture");
});

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "real install.sh installs, privately hands off, and persists --no-app",
  async () => {
    const f = await fixture();
    const source = join(f.dir, "runtime/clankie"),
      downloads = join(f.dir, "downloads"),
      commands = join(f.dir, "commands"),
      home = join(f.dir, "home");
    for (const dir of [
      join(source, "bin"),
      join(source, "libexec"),
      join(source, "scripts/release"),
      downloads,
      commands,
      home,
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(join(source, "VERSION"), "v1.0.0\n");
    await writeFile(
      join(source, "scripts/release/mac-app.json"),
      await readFile(join(f.release, "scripts/release/mac-app.json")),
    );
    await symlink(process.execPath, join(source, "libexec/node"));
    await build({
      entryPoints: [resolve(import.meta.dirname, "../bin/mac-app-install.ts")],
      outfile: join(source, "apps/tui/bin/mac-app-install.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
    });
    // The bootstrap is ESM; official bundles execute in their own ESM package too.
    await writeFile(join(source, "package.json"), '{"type":"module"}');
    for (const command of ["clankie", "clankie-herdr"]) {
      const path = join(source, "bin", command);
      await writeFile(
        path,
        `#!/bin/sh
printf '%s\\n' "$*" >> "$APP_TEST_CALLS"
if [ "$1" = pair ]; then echo '{"ok":true,"localCompanion":true,"private":"synthetic-handoff-marker"}'; else echo '{"ok":true}'; fi
`,
      );
      await chmod(path, 0o755);
    }
    await writeFile(join(commands, "open"), '#!/bin/sh\nprintf "open %s\\n" "$1" >> "$APP_TEST_CALLS"\n');
    await chmod(join(commands, "open"), 0o755);
    await writeFile(
      join(commands, "curl"),
      '#!/bin/sh\nfor arg do case "$arg" in https:*) name="${arg##*/}";; esac; done\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$APP_TEST_DOWNLOADS/$name" "$2"\n',
    );
    await chmod(join(commands, "curl"), 0o755);
    const archiveName = "clankie-darwin-arm64.tar.gz",
      archive = join(downloads, archiveName);
    execFileSync("tar", ["-czf", archive, "-C", join(f.dir, "runtime"), "clankie"]);
    await writeFile(
      `${archive}.sha256`,
      `${createHash("sha256")
        .update(await readFile(archive))
        .digest("hex")}  ${archiveName}\n`,
    );
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${commands}:${process.env.PATH}`,
      CLANKIE_INSTALL_ROOT: f.install,
      CLANKIE_BIN_DIR: join(f.dir, "bin"),
      CLANKIE_APPLICATIONS_DIR: f.apps,
      CLANKIE_NO_MODIFY_PATH: "1",
      APP_TEST_DOWNLOADS: downloads,
      APP_TEST_CALLS: join(f.dir, "calls"),
    };
    const installer = resolve(import.meta.dirname, "../../../install.sh");
    const installed = await exec("sh", [installer, "--version", "v1.0.0"], { env });
    expect(installed.stdout).not.toContain("synthetic-handoff-marker");
    expect(await readlink(join(f.install, "current"))).toBe("releases/v1.0.0");
    expect(await readFile(env.APP_TEST_CALLS, "utf8")).toContain("pair --local-companion --json");
    expect(await readFile(env.APP_TEST_CALLS, "utf8")).toContain(`open ${f.apps}/Clankie.app`);
    const calls = await readFile(env.APP_TEST_CALLS, "utf8");
    await exec("sh", [installer, "--version", "v1.0.0", "--no-app"], { env });
    expect(JSON.parse(await readFile(join(f.install, "app-policy.json"), "utf8"))).toEqual({
      disabled: true,
    });
    expect((await readFile(env.APP_TEST_CALLS, "utf8")).split("pair --local-companion").length).toBe(
      calls.split("pair --local-companion").length,
    );
    expect(existsSync(join(f.apps, "Clankie.app"))).toBe(true);
  },
);
