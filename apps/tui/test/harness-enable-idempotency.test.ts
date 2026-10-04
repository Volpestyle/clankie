import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { confirmClaudeWorkerEnabled } from "../../../integrations/claude-plugin/worker/bin/harness-install.mjs";
import { installHarnessBridges } from "../src/harness-install.ts";
const alreadyEnabled =
  '✘ Failed to enable plugin "clankie-worker@clankie": Plugin "clankie-worker@clankie" is already enabled at user scope\n';
it.each([
  "enabled",
  "windows-lf",
  "windows-crlf",
  "unprefixed",
  "unknown-marker",
  "wrong-plugin",
  "wrong-scope",
  "extra-line",
  "wrong-error",
  "disabled",
  "wrong-profile",
  "wrong-code",
  "retarget",
])("handles only verified already-enabled native result: %s", async (kind) => {
  const home = await mkdtemp(join(tmpdir(), "clankie-enable-"));
  const profile = join(home, ".claude"),
    config = join(profile, "settings.json");
  try {
    await mkdir(profile);
    await writeFile(config, "{}");
    const results = await installHarnessBridges({
      repoRoot: home,
      env: { HOME: home },
      consent: async () => true,
      execute: async (command, args) => {
        if (command !== "claude") throw new Error("absent");
        if (args[1] !== "enable") return;
        const enabled = JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": true } });
        if (kind !== "disabled" && kind !== "wrong-profile") await writeFile(config, enabled);
        if (kind === "wrong-profile") await writeFile(join(home, "other-settings.json"), enabled);
        if (kind === "retarget") {
          const other = join(home, "source.json");
          await writeFile(other, enabled);
          await rm(config);
          await symlink(other, config);
        }
        throw Object.assign(new Error("Native enable failed"), {
          code: kind === "wrong-code" ? 2 : 1,
          stdout: "",
          stderr:
            kind === "wrong-error"
              ? "Permission denied"
              : kind === "windows-lf"
                ? alreadyEnabled.replace("✘", "×")
                : kind === "windows-crlf"
                  ? alreadyEnabled.replace("✘", "×").replace("\n", "\r\n")
                  : kind === "unprefixed"
                    ? alreadyEnabled.slice(2)
                    : kind === "unknown-marker"
                      ? alreadyEnabled.replace("✘", "!")
                      : kind === "wrong-plugin"
                        ? alreadyEnabled.replaceAll("clankie-worker@clankie", "other@clankie")
                        : kind === "wrong-scope"
                          ? alreadyEnabled.replace("user scope", "project scope")
                          : kind === "extra-line"
                            ? alreadyEnabled + "Permission denied\n"
                            : alreadyEnabled,
        });
      },
    });
    expect(results.find((row) => row.profile === profile)?.status).toBe(
      ["enabled", "windows-lf", "windows-crlf"].includes(kind) ? "installed" : "failed",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("requires an existing fresh profile even for the captured Windows native result", async () => {
  const error = { code: 1, stdout: "", stderr: alreadyEnabled.replace("✘", "×") };
  expect(
    await confirmClaudeWorkerEnabled(error, {
      profile: "/missing/claude-fixture",
      source: "/missing/claude-fixture/settings.json",
      configBefore: "{}",
    }),
  ).toBe(false);
});
