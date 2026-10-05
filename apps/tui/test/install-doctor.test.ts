import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileCredentialStore,
  LINEAR_WEBHOOK_PROVIDER_ID,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
  mintOperatorToken,
} from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createFleetSettingsRoutes } from "../../clankie/src/fleet-settings-routes.ts";
import { formatDoctorReport } from "../src/doctor-report.ts";
import { SETTINGS_SCHEMA_VERSION, SettingsStore } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import { inspectInstall, inspectInstallKind, type ExecFileImpl } from "../src/install-doctor.ts";

import { doctorCommand, formatDoctorSummary } from "../src/command/doctor.ts";

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

it("doctor resolves current workspace preferences before any agent is started and explains project versus global", async () => {
  const root = await realpath(await installRoot());
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: root }],
          autonomy: { fleet: { commit: "owner", release: { mode: "time_rule", rule: "After a week." } } },
        },
      ],
    }),
  }));
  const routes = createFleetSettingsRoutes(
    async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? true : "authentication_required",
    settings,
  );
  const options = {
    repoRoot: root,
    cwd: root,
    settings,
    credentialStore: credentials,
    env: { HOME: root, CLANKIE_OPERATOR_TOKEN: token },
    execFileImpl: missing,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url));
      return path.pathname.includes("fleet-settings")
        ? routes.request(path.pathname + path.search, init)
        : Response.json({}, { status: 404 });
    }) as typeof fetch,
  };
  const before = await readFile(settings.path, "utf8");
  const report = await doctorCommand(options);
  expect(report.workingPreferences).toMatchObject({
    status: "available",
    projectId: "garden",
    effective: { commit: "owner", push: "lead", release: { mode: "time_rule", rule: "After a week." } },
  });
  expect(formatDoctorReport(report)).toContain("project garden overrides global defaults");
  expect(formatDoctorReport(report)).toContain("Release: time_rule.");
  expect(await readFile(settings.path, "utf8")).toBe(before);
  await settings.update((current) => ({ ...current, projects: ProjectsSettingsSchema.parse({}) }));
  const global = await doctorCommand(options);
  expect(global.workingPreferences).toMatchObject({
    status: "available",
    effective: { release: { mode: "owner" } },
  });
  expect(formatDoctorReport(global)).toContain("global defaults (no approved project)");
});

describe("install doctor", () => {
  it("reports the tracker backend and selection reason without probing or writing Linear", async () => {
    const root = await installRoot();
    const settings = new SettingsStore(join(root, "settings.json"));
    const credentials = new FileCredentialStore(join(root, "credentials.json"));
    const inspect = () =>
      inspectInstall({
        repoRoot: root,
        env: {
          HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"),
          CLANKIE_STATE: join(root, "state"),
        },
        settings,
        credentialStore: credentials,
        execFileImpl: missing,
        fetchImpl: offline,
      });
    const local = await inspect();
    expect(local.tracker).toEqual({
      backend: "local",
      reason: "linear_disconnected",
      directory: join(root, "state", "tracker"),
    });
    expect(formatDoctorReport(local)).toContain(
      "Tracker · local · Linear disconnected; using durable local store",
    );
    await credentials.set("linear", { type: "api", key: "isolated-doctor-fixture" });
    const connected = await inspect();
    expect(connected.tracker).toEqual({ backend: "linear", reason: "owner_connected" });
    expect(formatDoctorReport(connected)).toContain("Tracker · linear · owner-connected Linear account");
    await settings.update((current) => ({
      ...current,
      mcp: {
        ...current.mcp,
        servers: [
          {
            id: "linear",
            transport: "http",
            url: "http://127.0.0.1:1/mcp",
            credential: "linear",
            args: [],
            lane: "everywhere",
            initialTools: [],
            enabled: false,
          },
        ],
      },
    }));
    const disabled = await inspect();
    expect(disabled.tracker).toEqual({
      backend: "local",
      reason: "linear_disabled",
      directory: join(root, "state", "tracker"),
    });
    expect(formatDoctorReport(disabled)).toContain(
      "Tracker · local · Linear disabled; using durable local store",
    );
    expect(JSON.stringify(disabled)).not.toContain("isolated-doctor-fixture");
  });

  it("keeps missing webhook credentials separate from an empty owner rule", async () => {
    const root = await installRoot();
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      linearWebhook: {
        ...current.linearWebhook,
        following: true,
        url: "https://example.com/linear",
        wake: { ...current.linearWebhook.wake, ownerUserEmails: [] },
      },
    }));
    const report = await inspectInstall({
      repoRoot: root,
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
      settings,
      credentialStore: new FileCredentialStore(join(root, "credentials.json")),
      execFileImpl: missing,
      fetchImpl: offline,
    });
    expect(report.linear).toMatchObject({
      following: true,
      active: false,
      webhookConfigured: false,
      reason: "linear_webhook_required",
      missingWebhook: ["secret"],
      wakeWarning: "following is on, but no owner IDs or emails, so owner comments never wake.",
    });
  });

  it.each([
    { following: true, actors: ["owner"], ownerUserIds: [], warning: true, otherActors: false },
    { following: false, actors: ["owner"], ownerUserIds: [], warning: false, otherActors: false },
    { following: true, actors: ["owner"], ownerUserIds: ["james"], warning: false, otherActors: false },
    { following: true, actors: ["human"], ownerUserIds: [], warning: false, otherActors: true },
    { following: true, actors: ["owner", "human"], ownerUserIds: [], warning: true, otherActors: true },
  ] as const)("reports ineffective owner wake rules without changing configuration: %j", async (input) => {
    const root = await installRoot();
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      linearWebhook: {
        ...current.linearWebhook,
        following: input.following,
        url: "https://example.com/linear",
        wake: {
          ...current.linearWebhook.wake,
          actors: [...input.actors],
          ownerUserIds: [...input.ownerUserIds],
          ownerUserEmails: [],
        },
      },
    }));
    const store = new FileCredentialStore(join(root, "credentials.json"));
    const secret = "doctor-linear-secret-must-not-leak";
    await store.set(LINEAR_WEBHOOK_PROVIDER_ID, { type: "api", key: secret });
    const before = await settings.load();
    const report = await inspectInstall({
      repoRoot: root,
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
      settings,
      credentialStore: store,
      execFileImpl: missing,
      fetchImpl: offline,
    });
    const warning = "following is on, but no owner IDs or emails, so owner comments never wake.";
    const diagnostic = input.warning
      ? `${warning}${input.otherActors ? " Other selected actor rules may still wake." : ""}`
      : null;
    expect(report.linear).toMatchObject({
      following: input.following,
      active: input.following,
      webhookConfigured: true,
      wakeWarning: diagnostic,
    });
    expect(report.remediations.some((entry) => entry.includes(warning))).toBe(input.warning);
    if (input.warning) {
      expect(report.remediations).toContain(
        `${diagnostic} Set owner IDs or emails with \`clankie linear wake set --owner-user-emails EMAILS\`.`,
      );
    }
    expect(await settings.load()).toEqual(before);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

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
    await mkdir(join(root, "vendor"));
    await writeFile(
      join(root, "vendor/opinionated-skills.json"),
      JSON.stringify({ skills: { lead: "agent/lead" } }),
    );
    for (const name of ["lead", "this-machine"]) {
      await mkdir(join(root, ".agents/skills", name), { recursive: true });
      await writeFile(join(root, ".agents/skills", name, "SKILL.md"), "test");
    }
    const settings = new SettingsStore(join(configHome, "clankie", "settings.json"));
    await settings.update((current) => ({
      ...current,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      skills: { opinionated: false, exclude: [] },
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

    expect(report.skills.selection).toEqual({ opinionated: false, exclude: [] });
    expect(report.skills.catalog).toContainEqual(
      expect.objectContaining({ name: "lead", class: "opinionated", included: false }),
    );
    expect(report.skills.catalog).toContainEqual(
      expect.objectContaining({ name: "this-machine", class: "product", included: true }),
    );
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
      "Pick a captain model with `clankie model set provider/model` or `/setup`.",
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
      expect(formatDoctorSummary(report)).toContain("selected model ds4/DeepSeek-V4-Flash is unavailable");
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
      expect(formatDoctorSummary(report)).toContain("/auth ds4");
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
        () =>
          Promise.resolve(new Response(JSON.stringify({ doorway: { state: "disabled" } }), { status: 401 })),
        store,
      );
      expect(healthy.remediations).toEqual([]);
      expect(formatDoctorSummary(healthy)).toBe("ready");

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
      // The lane-tools route and the doorway are probed on every run; a builtin
      // provider is not.
      expect(probed).toEqual([builtin.laneTools.url, "http://127.0.0.1:4310/health"]);
      expect(builtin.selectedModel).toEqual({
        ref: "xai/grok-4.6",
        providerId: "xai",
        modelId: "grok-4.6",
      });
      // No key is stored for xai, so every turn would fail; the card says so.
      expect(builtin.captain).toEqual({
        ready: false,
        reason: "no_credential",
        model: "xai/grok-4.6",
        providerId: "xai",
      });
      expect(builtin.remediations).toEqual([
        "Every turn on xai/grok-4.6 fails until xai is signed in; run `/setup` or `/auth` in the console.",
      ]);
    });
  });

  it("names where a harness reaches his tools, on the evidence of the route's own 401", async () => {
    const root = await installRoot();
    const env = {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310/",
    };
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

  it("asks for a sign-in when the Mac is shut out of its own doorway", async () => {
    const root = await installRoot();
    const env = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") };
    const store = new FileCredentialStore(join(root, "credentials.json"));
    const signedOut = await inspectInstall({
      repoRoot: root,
      env,
      credentialStore: store,
      execFileImpl: missing,
      fetchImpl: (input) =>
        String(input).endsWith("/health")
          ? Promise.resolve(
              Response.json({
                ok: true,
                service: "clankie",
                doorway: { state: "sign_in_required", since: "2026-09-14T10:11:40.689Z" },
              }),
            )
          : Promise.resolve(new Response("", { status: 404 })),
    });
    const open = await inspectInstall({
      repoRoot: root,
      env,
      credentialStore: store,
      execFileImpl: missing,
      fetchImpl: (input) =>
        String(input).endsWith("/health")
          ? Promise.resolve(Response.json({ ok: true, service: "clankie", doorway: { state: "connected" } }))
          : Promise.resolve(new Response("", { status: 404 })),
    });

    expect(signedOut.doorway).toMatchObject({ state: "sign_in_required" });
    expect(signedOut.remediations).toContain(
      "This Mac has been signed out of the public doorway since 2026-09-14T10:11:40.689Z; no app reaches him until you sign it back in with /remote-access.",
    );
    expect(signedOut.nextStep).toContain("Sign this Mac back in");
    expect(open.nextStep).toContain("clankie pair");
    expect(open.doorway).toEqual({ state: "connected" });
    expect(open.remediations.join(" ")).not.toContain("doorway");
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

    // A signed-in model, so the only thing this install still needs is the plugin link.
    const credentialStore = new FileCredentialStore(join(root, "credentials.json"));
    await credentialStore.set("xai", { type: "api", key: "xai-test-key" });
    const report = await inspectInstall({
      repoRoot: root,
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: configHome },
      credentialStore,
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
      env: {
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: configHome,
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/tmp/unrelated.sock",
      },
      execFileImpl: async (command, args) => {
        if (command === join(root, "libexec/herdr")) {
          expect(args).toEqual(["--version"]);
          return { stdout: "herdr 0.8.2\n", stderr: "" };
        }
        return missing(command, args);
      },
      credentialStore,
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
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), PATH: bin },
      credentialStore: new FileCredentialStore(join(root, "credentials.json")),
      execFileImpl,
      fetchImpl: offline,
    });

    expect(report.commands["herdr-lead"]).toEqual({ present: true });
    expect(called).not.toContain("herdr-lead");
  });
});

it("discovers only running owner Herdr sessions using a read-only installed CLI probe", async () => {
  const root = await installRoot();
  const calls: string[][] = [];
  const report = await inspectInstall({
    repoRoot: root,
    env: { HOME: root, XDG_CONFIG_HOME: root },
    settings: new SettingsStore(join(root, "settings.json")),
    credentialStore: new FileCredentialStore(join(root, "credentials.json")),
    fetchImpl: offline,
    execFileImpl: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "herdr" && args.join(" ") === "session list --json")
        return {
          stdout: JSON.stringify({
            sessions: [
              { name: "work", running: true, socket_path: "/tmp/work" },
              { name: "saved", running: false, socket_path: "/tmp/saved" },
            ],
          }),
          stderr: "",
        };
      return missing(command, args);
    },
  });
  expect(report.ownerHerdrSessions).toEqual(["work"]);
  expect(calls.filter((call) => call[0] === "herdr")).toEqual([["herdr", "session", "list", "--json"]]);
});
