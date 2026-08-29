import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SETTINGS_SCHEMA_VERSION, SettingsStore } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import { inspectInstall, inspectInstallKind, type ExecFileImpl } from "../src/install-doctor.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function installRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-install-doctor-"));
  tempDirs.push(root);
  return root;
}

const missing: ExecFileImpl = async () => {
  throw Object.assign(new Error("not found"), { code: "ENOENT" });
};

describe("install doctor", () => {
  it("treats a tree with libexec/node and release.json as a release", async () => {
    const root = await installRoot();
    await mkdir(join(root, "libexec"), { recursive: true });
    await writeFile(join(root, "libexec", "node"), "");
    await writeFile(join(root, "release.json"), `${JSON.stringify({ version: "v0.2.0" })}\n`);
    expect(inspectInstallKind(root)).toBe("release");
    expect(inspectInstallKind(await installRoot())).toBe("checkout");
  });

  it("reports ids not secrets, and names the setup steps this install still needs", async () => {
    const root = await installRoot();
    const configHome = join(root, "config");
    const secret = "sk-secret-must-not-leak-xyz";
    await mkdir(join(configHome, "clankie"), { recursive: true });
    await writeFile(
      join(configHome, "clankie", "clankie.json"),
      `${JSON.stringify({ image_model: "xai/grok-imagine" })}\n`,
    );
    await writeFile(join(root, "package.json"), `${JSON.stringify({ version: "0.2.0" })}\n`);
    await mkdir(join(root, "integrations", "herdr-plugin"), { recursive: true });
    await writeFile(join(root, "integrations", "herdr-plugin", "herdr-plugin.toml"), 'id = "clankie"\n');
    const settings = new SettingsStore(join(configHome, "clankie", "settings.json"));
    await settings.update((current) => ({
      ...current,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      discord: { ...current.discord, activeBody: "bot", textIngressEnabled: true },
    }));
    const store = new FileCredentialStore(join(root, "credentials.json"));
    await store.set("openai", { type: "api", key: secret });

    const report = await inspectInstall({
      repoRoot: root,
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: configHome },
      settings,
      credentialStore: store,
      execFileImpl: missing,
    });

    expect(report.kind).toBe("checkout");
    expect(report.version).toBe("0.2.0");
    expect(report.model).toBeNull();
    expect(report.imageModel).toBe("xai/grok-imagine");
    expect(report.discord.activeBody).toBe("bot");
    expect(report.discord.textIngressEnabled).toBe(true);
    expect(report.credentials).toEqual([{ id: "openai", type: "api" }]);
    expect(report.commands.herdr).toEqual({ present: false });
    expect(report.commands["herdr-lead"]).toEqual({ present: false });
    expect(report.herdrPlugin).toEqual({
      bundled: true,
      bundlePath: join(root, "integrations", "herdr-plugin"),
    });
    expect(report.remediations).toEqual([
      "Pick a captain model in the operator console with /model.",
      "Store a Discord bot token with /discord.",
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("asks to link a bundled herdr plugin when herdr is present and the plugin is not linked", async () => {
    const root = await installRoot();
    await mkdir(join(root, "libexec"), { recursive: true });
    await writeFile(join(root, "libexec", "node"), "");
    await writeFile(join(root, "release.json"), `${JSON.stringify({ version: "v0.2.0" })}\n`);
    await mkdir(join(root, "integrations", "herdr-plugin"), { recursive: true });
    await writeFile(join(root, "integrations", "herdr-plugin", "herdr-plugin.toml"), 'id = "clankie"\n');
    const configHome = join(root, "config");
    await mkdir(join(configHome, "clankie"), { recursive: true });
    await writeFile(
      join(configHome, "clankie", "clankie.json"),
      `${JSON.stringify({ model: "xai/grok-4" })}\n`,
    );
    const pluginPath = join(root, "integrations", "herdr-plugin");
    const execFileImpl: ExecFileImpl = async (command, args) => {
      if (command === "herdr" && args[0] === "plugin") {
        return { stdout: JSON.stringify({ result: { plugins: [] } }), stderr: "" };
      }
      if (command === "herdr") return { stdout: "herdr 0.7.3\n", stderr: "" };
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    };

    const report = await inspectInstall({
      repoRoot: root,
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: configHome },
      execFileImpl,
    });

    expect(report.kind).toBe("release");
    expect(report.version).toBe("v0.2.0");
    expect(report.model).toBe("xai/grok-4");
    expect(report.commands.herdr).toEqual({ present: true, detail: "herdr 0.7.3" });
    expect(report.herdrPlugin).toEqual({ bundled: true, bundlePath: pluginPath, linked: false });
    expect(report.remediations).toEqual([`herdr plugin link ${pluginPath}`]);
  });

  it("treats herdr-lead as present from PATH without executing it", async () => {
    const root = await installRoot();
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "herdr-lead"), "", { mode: 0o755 });
    const called: string[] = [];
    const execFileImpl: ExecFileImpl = async (command) => {
      called.push(command);
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    };

    const report = await inspectInstall({
      repoRoot: root,
      env: { HOME: join(root, "home"), PATH: bin },
      execFileImpl,
    });

    expect(report.commands["herdr-lead"]).toEqual({ present: true });
    expect(called).not.toContain("herdr-lead");
  });
});
