import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { ownerConfigRoots } from "../../../scripts/testing/vitest-setup.ts";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureConfig = fileURLToPath(new URL("./fixtures/store-isolation.config.ts", import.meta.url));
const guard = new URL("./fixtures/store-isolation-guard.mjs", import.meta.url).href;

it.each(["populated", "empty", "missing"])(
  "never reads or writes a %s owner config, including inherited overrides and child processes",
  async (state) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-owner-isolation-")));
    const ownerHome = join(root, "owner");
    const ownerConfig = join(ownerHome, ".config", "clankie");
    const ownerTemp = join(root, "inherited-queue-temporary-directory-with-long-socket-paths");
    const settings = join(ownerConfig, "settings.json");
    const credentials = join(ownerConfig, "credentials.json");
    const poison = "owner fixture: intentionally invalid JSON\n";
    try {
      await mkdir(ownerTemp, { recursive: true });
      if (state !== "missing") await mkdir(ownerConfig, { recursive: true });
      if (state === "populated") {
        await writeFile(settings, poison);
        await writeFile(credentials, poison);
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: ownerHome,
        USERPROFILE: ownerHome,
        TMPDIR: ownerTemp,
        TMP: ownerTemp,
        TEMP: ownerTemp,
        TEST_OWNER_TEMP: ownerTemp,
        XDG_CONFIG_HOME: join(ownerHome, ".config"),
        CLANKIE_SETTINGS_FILE: settings,
        CLANKIE_CREDENTIALS_FILE: credentials,
        ANTHROPIC_API_KEY: "synthetic-inherited-key",
        DISCORD_BOT_TOKEN: "synthetic-inherited-token",
        TEST_OWNER_HOME: ownerHome,
        TEST_FORBIDDEN_CONFIG_ROOTS: JSON.stringify([ownerConfig, ...ownerConfigRoots]),
        NODE_OPTIONS: `--import=${guard}`,
      };
      delete env.CLANKIE_TEST_LIVE_STORES;
      const result = await run(
        process.execPath,
        [join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--config", fixtureConfig],
        { cwd: repoRoot, env, timeout: 25_000, maxBuffer: 1024 * 1024 },
      );
      expect(result.stdout).toContain("1 passed");
      const isolatedHome = /ISOLATED_HOME=([^\r\n]+)/u.exec(result.stdout)?.[1];
      expect(isolatedHome).toBeDefined();
      await expect(access(isolatedHome!)).rejects.toHaveProperty("code", "ENOENT");
      const isolatedTemp = /ISOLATED_TEMP=([^\r\n]+)/u.exec(result.stdout)?.[1];
      expect(isolatedTemp).toBeDefined();
      await expect(access(isolatedTemp!)).rejects.toHaveProperty("code", "ENOENT");
      if (state === "populated") {
        expect(await readFile(settings, "utf8")).toBe(poison);
        expect(await readFile(credentials, "utf8")).toBe(poison);
      } else {
        await expect(access(settings)).rejects.toHaveProperty("code", "ENOENT");
        await expect(access(credentials)).rejects.toHaveProperty("code", "ENOENT");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
