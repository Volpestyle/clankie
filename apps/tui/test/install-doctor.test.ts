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

/** Probes are a seam so a run never depends on what happens to answer locally. */
const offline: typeof fetch = () => Promise.reject(new Error("no probe in tests"));

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
      fetchImpl: offline,
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
      "Pick a captain model with `clankie model set provider/model` or `/model`.",
      "Store a Discord bot token with /discord.",
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  describe("the selected model", () => {
    async function doctorWith(
      provider: Record<string, unknown>,
      model: string,
      fetchImpl: typeof fetch,
      credentials?: FileCredentialStore,
    ) {
      const root = await installRoot();
      const configHome = join(root, "config");
      await mkdir(join(configHome, "clankie"), { recursive: true });
      await writeFile(
        join(configHome, "clankie", "clankie.json"),
        `${JSON.stringify({ model, provider })}\n`,
      );
      return await inspectInstall({
        repoRoot: root,
        env: { HOME: join(root, "home"), XDG_CONFIG_HOME: configHome },
        ...(credentials === undefined ? {} : { credentialStore: credentials }),
        execFileImpl: missing,
        fetchImpl,
      });
    }

    const localProvider = {
      ds4: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:8000/v1" },
        models: { "DeepSeek-V4-Flash": {} },
      },
    };

    it("says the runtime is down rather than reporting a healthy install", async () => {
      const empty = new FileCredentialStore(join(await installRoot(), "credentials.json"));
      const report = await doctorWith(
        localProvider,
        "ds4/DeepSeek-V4-Flash",
        () => Promise.reject(new Error("fetch failed")),
        empty,
      );
      expect(report.selectedModel?.endpoint).toMatchObject({ reachable: false });
      expect(report.remediations).toContain(
        "Start the runtime behind http://127.0.0.1:8000/v1; every captain turn on ds4/DeepSeek-V4-Flash fails until it answers.",
      );
    });

    it("names the credential an endpoint asks for, on the evidence of its own 401", async () => {
      // An explicit empty store: the default one is the OS keychain on darwin,
      // which ignores HOME and would answer with the developer's real keys.
      const empty = new FileCredentialStore(join(await installRoot(), "credentials.json"));
      const report = await doctorWith(
        localProvider,
        "ds4/DeepSeek-V4-Flash",
        () => Promise.resolve(new Response("", { status: 401 })),
        empty,
      );
      expect(report.selectedModel?.endpoint).toMatchObject({ reachable: true, authRequired: true });
      expect(report.remediations).toContain(
        "http://127.0.0.1:8000/v1 requires a key and none is stored for ds4; add it with `/auth ds4`.",
      );
    });

    it("catches a ref naming a model the provider does not declare", async () => {
      const empty = new FileCredentialStore(join(await installRoot(), "credentials.json"));
      const report = await doctorWith(
        localProvider,
        "ds4/deepseek-v4-flash",
        () => Promise.resolve(new Response("{}", { status: 200 })),
        empty,
      );
      expect(report.selectedModel?.endpoint).toMatchObject({ declaresModel: false });
      expect(report.remediations).toContain(
        "Provider ds4 declares no model deepseek-v4-flash; re-probe with `clankie model add-local --id ds4 --base-url http://127.0.0.1:8000/v1`.",
      );
    });

    it("stays quiet for a healthy local endpoint, and never probes a builtin provider", async () => {
      const store = new FileCredentialStore(join(await installRoot(), "credentials.json"));
      await store.set("ds4", { type: "api", key: "k" });
      const healthy = await doctorWith(
        localProvider,
        "ds4/DeepSeek-V4-Flash",
        () => Promise.resolve(new Response("{}", { status: 401 })),
        store,
      );
      expect(healthy.remediations).toEqual([]);

      const probed: string[] = [];
      const builtin = await doctorWith(
        {},
        "xai/grok-4.6",
        (input) => {
          probed.push(String(input));
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
        new FileCredentialStore(join(await installRoot(), "credentials.json")),
      );
      // The lane-tools route is probed on every run; a builtin provider is not.
      expect(probed).toEqual([builtin.laneTools.url]);
      expect(builtin.selectedModel).toEqual({
        ref: "xai/grok-4.6",
        providerId: "xai",
        modelId: "grok-4.6",
      });
      expect(builtin.remediations).toEqual([]);
    });
  });

  it("names where a harness reaches his tools, on the evidence of the route's own 401", async () => {
    const root = await installRoot();
    const env = { HOME: join(root, "home"), CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310/" };
    const store = new FileCredentialStore(join(root, "credentials.json"));
    const served = await inspectInstall({
      repoRoot: root,
      env,
      credentialStore: store,
      execFileImpl: missing,
      fetchImpl: (input) =>
        Promise.resolve(new Response("", { status: String(input).endsWith("/v1/mcp") ? 401 : 404 })),
    });
    const unserved = await inspectInstall({
      repoRoot: root,
      env,
      credentialStore: store,
      execFileImpl: missing,
      fetchImpl: () => Promise.resolve(new Response("", { status: 404 })),
    });

    expect(served.laneTools).toEqual({ url: "http://127.0.0.1:4310/v1/mcp", reachable: true });
    expect(unserved.laneTools).toEqual({ url: "http://127.0.0.1:4310/v1/mcp", reachable: false });
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
    await writeFile(
      join(configHome, "clankie", "settings.json"),
      JSON.stringify({ schemaVersion: 1, herdr: { runtime: "external" } }),
    );
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
      fetchImpl: offline,
    });

    expect(report.kind).toBe("release");
    expect(report.version).toBe("v0.2.0");
    expect(report.model).toBe("xai/grok-4");
    expect(report.commands.herdr).toEqual({ present: true, detail: "herdr 0.7.3" });
    expect(report.herdrPlugin).toEqual({ bundled: true, bundlePath: pluginPath, linked: false });
    expect(report.remediations).toEqual([`herdr plugin link ${pluginPath}`]);
    await writeFile(join(configHome, "clankie", "settings.json"), JSON.stringify({ schemaVersion: 1 }));
    const owned = await inspectInstall({
      repoRoot: root,
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: configHome },
      execFileImpl: async (command, args) => {
        if (command === join(root, "libexec/herdr")) {
          expect(args).toEqual(["--version"]);
          return { stdout: "herdr 0.8.2\n", stderr: "" };
        }
        return missing(command, args);
      },
      fetchImpl: offline,
    });
    expect(owned.commands.herdr).toEqual({ present: true, detail: "herdr 0.8.2" });
    expect(owned.remediations).toEqual([]);
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
      fetchImpl: offline,
    });

    expect(report.commands["herdr-lead"]).toEqual({ present: true });
    expect(called).not.toContain("herdr-lead");
  });
});
