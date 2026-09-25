import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "installer switches and rolls back immutable versions without changing user state",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-installer-"));
    const installer = fileURLToPath(new URL("../../../install.sh", import.meta.url));
    const downloads = join(root, "downloads");
    const commands = join(root, "commands");
    const installation = join(root, "install");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const configHome = join(home, ".config");
    const stateHome = join(home, ".local", "state");
    const archiveName = "clankie-darwin-arm64.tar.gz";
    try {
      await mkdir(commands);
      // Only HTTP responses are fixtures; run the real installer, tar and checksum tools.
      const curl = join(commands, "curl");
      await writeFile(
        curl,
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const url = new URL(args.find(arg => arg.startsWith("https://")));
const prefix = "/Volpestyle/clankie/releases/download/";
if (url.hostname !== "github.com" || !url.pathname.startsWith(prefix)) process.exit(2);
fs.copyFileSync(path.join(process.env.INSTALL_TEST_DOWNLOADS, url.pathname.slice(prefix.length)), args[args.indexOf("-o") + 1]);
`,
      );
      await chmod(curl, 0o755);
      const env = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        CLANKIE_STATE_HOME: stateHome,
        CLANKIE_SETTINGS_FILE: join(configHome, "clankie", "settings.json"),
        PATH: `${commands}:${process.env.PATH}`,
        CLANKIE_INSTALL_ROOT: installation,
        CLANKIE_BIN_DIR: bin,
        INSTALL_TEST_DOWNLOADS: downloads,
      };
      const userFiles = [
        [env.CLANKIE_SETTINGS_FILE, '{"schemaVersion":1,"persona":{"displayName":"Clankie"}}\n'],
        [join(stateHome, "clankie", "tui", "prompt-history.jsonl"), '"remember this conversation"\n'],
      ] as const;
      for (const [path, contents] of userFiles) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents);
      }
      for (const version of ["v0.1.0", "v0.2.0"]) {
        const source = join(root, version);
        const destination = join(downloads, version);
        await mkdir(join(source, "clankie", "bin"), { recursive: true });
        await mkdir(destination, { recursive: true });
        await writeFile(join(source, "clankie", "VERSION"), `${version}\n`);
        for (const command of ["clankie", "clankie-herdr"])
          await writeFile(join(source, "clankie", "bin", command), version);
        const archive = join(destination, archiveName);
        const packed = spawnSync("tar", ["-czf", archive, "-C", source, "clankie"]);
        expect(packed.status).toBe(0);
        const digest = createHash("sha256")
          .update(await readFile(archive))
          .digest("hex");
        await writeFile(`${archive}.sha256`, `${digest}  ${archiveName}\n`);
      }
      for (const version of ["v0.1.0", "v0.2.0", "v0.1.0"]) {
        const installed = spawnSync("sh", [installer, "--version", version], { env, encoding: "utf8" });
        expect(installed.status, installed.stderr).toBe(0);
        expect(await readlink(join(installation, "current"))).toBe(`releases/${version}`);
        expect(await readFile(join(bin, "clankie"), "utf8")).toBe(version);
        expect(await readFile(join(bin, "clankie-herdr"), "utf8")).toBe(version);
        for (const [path, contents] of userFiles) expect(await readFile(path, "utf8")).toBe(contents);
      }
      const retained = join(installation, "releases", "v0.1.0", "retained");
      await writeFile(retained, "immutable directory");
      expect(spawnSync("sh", [installer, "--version", "v0.1.0"], { env }).status).toBe(0);
      expect(await readFile(retained, "utf8")).toBe("immutable directory");
      await writeFile(join(downloads, "v0.2.0", archiveName), "corrupt download");
      expect(spawnSync("sh", [installer, "--version", "v0.2.0"], { env }).status).not.toBe(0);
      expect(await readlink(join(installation, "current"))).toBe("releases/v0.1.0");
      for (const [path, contents] of userFiles) expect(await readFile(path, "utf8")).toBe(contents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
