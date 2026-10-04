import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Paths only, for the regression's access trap; never open the original stores.
export const ownerConfigRoots = [
  join(homedir(), ".config", "clankie"),
  ...(process.env.XDG_CONFIG_HOME ? [join(process.env.XDG_CONFIG_HOME, "clankie")] : []),
];
// Descriptor bytes may be guarded in integration tests; paths only, no credentials.
export const ownerDescriptorPaths = [
  ...new Set([
    join(homedir(), ".clankie", "links", "default-local.json"),
    ...(process.env.CLANKIE_STATE?.trim()
      ? [join(process.env.CLANKIE_STATE.trim(), "links", "default-local.json")]
      : []),
  ]),
];

// Runs before each test file's imports, including package-local and eval runs.
// Separate roots also keep files from leaking settings into the next suite.
if (process.env.CLANKIE_TEST_LIVE_STORES !== "1") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clankie-vitest-")));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });

  // A caller's path overrides and authentication must not escape the fixture.
  // Tests that exercise env overrides supply their own synthetic values later.
  for (const name of Object.keys(process.env)) {
    if (
      /^(?:CLANKIE_|DISCORD_|HERDR_)/u.test(name) ||
      /(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN)$/u.test(name)
    ) {
      if (name !== "CLANKIE_KEYCHAIN_TESTS") delete process.env[name];
    }
  }

  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    CLANKIE_SETTINGS_FILE: join(home, ".config", "clankie", "settings.json"),
    CLANKIE_CREDENTIALS_FILE: join(home, ".config", "clankie", "credentials.json"),
  });

  // Leave HOME pointing at the removed fixture until the next setup installs
  // its root; late callbacks must never fall back to the owner's home.
  afterAll(() => rm(root, { recursive: true, force: true }));
}
