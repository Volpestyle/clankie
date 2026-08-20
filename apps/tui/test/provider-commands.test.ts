import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactCredential, type CredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { CatalogSchema, type Catalog, type ModelRegistry } from "@clankie/model-registry";
import { loadConfig, mergedCatalog, updateGlobalConfig } from "@clankie/model-provider";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProviderCommands,
  formatAuthStatus,
  formatModelBanner,
  validateApiKey,
  type ProviderServices,
} from "../src/provider-commands.ts";
import type { MenuOption, SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell, FaceShellCommand } from "../src/shell/shell.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function catalog(): Catalog {
  return CatalogSchema.parse({
    alpha: {
      id: "alpha",
      name: "Alpha Provider",
      env: [],
      models: {
        "alpha-one": {
          id: "alpha-one",
          name: "Alpha One",
          limit: { context: 100_000, output: 8_000 },
          reasoning: true,
        },
      },
    },
    beta: {
      id: "beta",
      name: "Beta Provider",
      env: [],
      models: {
        "beta-one": {
          id: "beta-one",
          name: "Beta One",
          limit: { context: 64_000, output: 4_000 },
        },
        "beta-two": {
          id: "beta-two",
          name: "Beta Two",
          limit: { context: 128_000, output: 8_000 },
        },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      models: {
        "gpt-5.5": {
          id: "gpt-5.5",
          name: "GPT-5.5",
          limit: { context: 400_000, output: 128_000 },
          reasoning: true,
        },
      },
    },
    xai: {
      id: "xai",
      name: "xAI",
      env: ["XAI_API_KEY"],
      models: {
        "grok-test": {
          id: "grok-test",
          name: "Grok Test",
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  });
}

function credentialStore(): {
  readonly store: CredentialStore;
  readonly values: Map<string, ProviderCredential>;
} {
  const values = new Map<string, ProviderCredential>();
  const store: CredentialStore = {
    async delete(providerId) {
      return values.delete(providerId);
    },
    async get(providerId) {
      return values.get(providerId);
    },
    async list() {
      return Object.fromEntries([...values].map(([id, value]) => [id, redactCredential(value)]));
    },
    async set(providerId, credential) {
      values.set(providerId, credential);
    },
  };
  return { store, values };
}

interface SelectRequest {
  readonly message: string;
  readonly options: readonly MenuOption[];
  readonly statusActions?: readonly MenuOption[];
}

interface CommandResult {
  readonly command: string;
  readonly text: string;
  readonly tone: string;
}

interface SecretRequest {
  readonly message: string;
  readonly error: string | undefined;
}

function testShell(
  selections: Array<string | undefined>,
  secrets: Array<string | undefined> = [],
  texts: Array<string | undefined> = [],
): {
  readonly lines: string[];
  readonly results: CommandResult[];
  readonly secrets: SecretRequest[];
  readonly selects: SelectRequest[];
  readonly shell: ClankieFaceShell;
  readonly statuses: string[];
} {
  const selects: SelectRequest[] = [];
  const results: CommandResult[] = [];
  const secretRequests: SecretRequest[] = [];
  const lines: string[] = [];
  const statuses: string[] = [];
  const flow: SetupFlow = {
    begin: () => {},
    end: () => {},
    readSelect: async (options) => {
      selects.push(options);
      return selections.shift();
    },
    readSecret: async (options) => {
      for (;;) {
        const value = secrets.shift();
        if (value === undefined) return undefined;
        const error = options.validate?.(value);
        secretRequests.push({ message: options.message, error });
        if (error === undefined) return value;
      }
    },
    readText: async () => texts.shift(),
    renderLine: (text) => {
      lines.push(text);
    },
    setStatus: (status) => {
      if (status !== undefined) statuses.push(status);
    },
    waitForInterrupt: () => ({ promise: new Promise<void>(() => {}), dispose: () => {} }),
  };
  const shell = {
    setupFlow: flow,
    insertCommandResult(command: string, text: string, tone: string): void {
      results.push({ command, text, tone });
    },
  } as unknown as ClankieFaceShell;
  return { lines, results, secrets: secretRequests, selects, shell, statuses };
}

async function testServices(
  options: {
    readonly captainModels?: ProviderServices["captainModels"];
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<{
  readonly changed: string[];
  readonly credentials: Map<string, ProviderCredential>;
  readonly env: NodeJS.ProcessEnv;
  readonly notifications: { count: number };
  readonly refreshes: { count: number };
  readonly services: ProviderServices;
}> {
  const root = await mkdtemp(join(tmpdir(), "clankie-provider-commands-"));
  tempDirs.push(root);
  const env = { XDG_CONFIG_HOME: join(root, "config") };
  const changed: string[] = [];
  const notifications = { count: 0 };
  const refreshes = { count: 0 };
  const credentials = credentialStore();
  const registry: ModelRegistry = {
    async catalog() {
      return catalog();
    },
    async refresh() {
      return { source: "network", updated: true };
    },
  };
  const currentCatalog = async () => mergedCatalog((await loadConfig({ env, cwd: root })).config, catalog());
  const captainModels: ProviderServices["captainModels"] = {
    async providers() {
      return Object.values(await currentCatalog()).map(({ id, name }) => ({ id, name }));
    },
    async models(providerId) {
      return Object.values((await currentCatalog())[providerId]?.models ?? {});
    },
    async thinkingLevels(providerId, modelId) {
      return (await currentCatalog())[providerId]?.models[modelId]?.reasoning
        ? ["off", "low", "medium", "high"]
        : ["off"];
    },
    async resolveSelection(config) {
      if (config.model === undefined) throw new Error("No captain model configured");
      return { model: {} as never, ref: config.model, thinkingLevel: "medium" };
    },
    async refresh() {
      refreshes.count += 1;
    },
    async register() {},
  };
  return {
    changed,
    env,
    notifications,
    refreshes,
    services: {
      cwd: root,
      env,
      captainModels: options.captainModels ?? captainModels,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      onConfigChanged(config) {
        notifications.count += 1;
        if (config.model !== undefined) changed.push(config.model);
      },
      registry,
      oauth: {
        async anthropicBrowser() {
          throw new Error("unexpected Anthropic OAuth call");
        },
        async codexBrowser() {
          throw new Error("unexpected Codex browser OAuth call");
        },
        async codexDevice() {
          throw new Error("unexpected Codex device OAuth call");
        },
        async xaiDevice() {
          throw new Error("unexpected xAI device OAuth call");
        },
      },
      store: credentials.store,
    },
    credentials: credentials.values,
  };
}

function command(commands: readonly FaceShellCommand[], name: string): FaceShellCommand {
  const found = commands.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing /${name} command`);
  return found;
}

function rendered(view: ReturnType<typeof testShell>): string {
  return [...view.results.map((result) => result.text), ...view.lines, ...view.statuses].join("\n");
}

const oauthCredential: ProviderCredential = {
  type: "oauth",
  access: "access-token-never-render",
  refresh: "refresh-token-never-render",
  expires: Date.now() + 60_000,
};

describe("auth command", () => {
  it("lists only broker-redacted credential state", async () => {
    const { credentials, services } = await testServices();
    credentials.set("openai", { type: "api", key: "sk-live-secret-value" });
    credentials.set("openai-codex", { ...oauthCredential, accountId: "account-safe-summary" });
    credentials.set("anthropic", { ...oauthCredential, accountId: "claude-account-summary" });
    const view = testShell([]);

    await command(buildProviderCommands(services), "auth").run("status", view.shell);

    const text = rendered(view);
    expect(text).toContain("providers:");
    expect(text).toMatch(/openai\s+API key/);
    expect(text).toMatch(/openai-codex\s+ChatGPT subscription/);
    expect(text).toContain("(account-safe-summary)");
    expect(text).toMatch(/anthropic\s+Claude subscription \(claude-account-summary\)/);
    expect(text).not.toContain("sk-l…");
    expect(text).not.toContain("sk-live-secret-value");
    expect(text).not.toContain(oauthCredential.access);
    expect(text).not.toContain(oauthCredential.refresh);
  });

  it("groups owner credentials and omits auto-minted local identities", () => {
    const now = Date.UTC(2026, 7, 15, 12, 0, 0);
    const text = formatAuthStatus(
      {
        anthropic: { type: "api", key: "sk-a…" },
        clankie_activity_producer: { type: "api", key: "clan…" },
        clankie_captain: { type: "api", key: "clan…" },
        clankie_discord_bridge: { type: "api", key: "clan…" },
        clankie_discord_user_bridge: { type: "api", key: "clan…" },
        clankie_discord_user_voice_bridge: { type: "api", key: "clan…" },
        clankie_discord_voice_bridge: { type: "api", key: "clan…" },
        clankie_operator: { type: "api", key: "clan…" },
        clankie_play_voice: { type: "api", key: "clan…" },
        discord_bot: { type: "api", key: "MTUz…" },
        elevenlabs: { type: "api", key: "sk_0…" },
        openai: { type: "api", key: "sk-p…" },
        "openai-codex": {
          type: "oauth",
          accountId: "0f892112-c0d9-4221-b57b-38181aa63f4c",
          expires: now + 3 * 60 * 60 * 1000,
        },
        xai: {
          type: "oauth",
          expires: now + 3 * 60 * 60 * 1000,
        },
      },
      { now },
    );

    expect(text).toBe(
      [
        "providers:",
        "  anthropic     API key",
        "  openai        API key",
        "  openai-codex  ChatGPT subscription · refreshes in 3h",
        "  xai           SuperGrok subscription · refreshes in 3h",
        "  google        missing",
        "  openrouter    missing",
        "  groq          missing",
        "  mistral       missing",
        "",
        "services:",
        "  elevenlabs   API key",
        "  discord_bot  bot token",
        "",
        "Worker harnesses keep their own logins (`codex login`, `claude login`).",
      ].join("\n"),
    );
    expect(text).not.toContain("sk-a…");
    expect(text).not.toContain("clan…");
    expect(text).not.toContain("0f892112-c0d9-4221-b57b-38181aa63f4c");
    expect(text).not.toContain("clankie_");
    expect(text).not.toContain("local identities");
    expect(text).not.toContain("auto-minted");
  });

  it("shows first-class slots as missing when nothing is stored", () => {
    const text = formatAuthStatus({});
    expect(text).toContain("  anthropic     missing");
    expect(text).toContain("  openai        missing");
    expect(text).toContain("  openai-codex  missing");
    expect(text).toContain("  elevenlabs   missing");
    expect(text).toContain("  discord_bot  missing");
    expect(text).not.toContain("No provider keys");
  });

  it("treats a featured provider present only in the environment as connected", () => {
    const text = formatAuthStatus({}, { envConnected: ["openai"] });
    expect(text).toContain("  openai        env");
    expect(text).toContain("  anthropic     missing");
  });

  it("does not offer auto-minted local identities for removal", async () => {
    const fixture = await testServices();
    fixture.credentials.set("openai", { type: "api", key: "sk-live-secret-value" });
    fixture.credentials.set("clankie_operator", { type: "api", key: "clankie_op_local-only" });
    const view = testShell(["remove", undefined]);

    await command(buildProviderCommands(fixture.services), "auth").run("", view.shell);

    expect(view.selects[0]?.message).toBe("Provider auth (1 credential stored)");
    expect(view.selects[1]?.options.map((option) => option.value)).toEqual(["openai"]);
  });

  it("validates API keys through masked input and stores only through the broker", async () => {
    const { credentials, services } = await testServices();
    const secret = "sk-valid-api-key";
    const view = testShell(["api", "openai", "done"], ["short", secret]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(view.secrets.map((request) => request.error)).toEqual([
      "That doesn't look like an API key.",
      undefined,
    ]);
    expect(credentials.get("openai")).toEqual({ type: "api", key: secret });
    expect(rendered(view)).not.toContain(secret);
    expect(validateApiKey("key with whitespace")).toBe("API keys cannot contain whitespace.");
  });

  it("features ElevenLabs in the API-key picker despite its absence from the catalog", async () => {
    const { credentials, services } = await testServices();
    const secret = "elevenlabs-live-key";
    const view = testShell(["api", "elevenlabs", "done"], [secret]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    const offered = view.selects[1]?.options.find((option) => option.value === "elevenlabs");
    expect(offered?.label).toBe("ElevenLabs");
    expect(credentials.get("elevenlabs")).toEqual({ type: "api", key: secret });
    expect(rendered(view)).toContain("Pick the ElevenLabs voice and model with /voice.");
    expect(rendered(view)).not.toContain(secret);

    const rerun = testShell(["api", undefined]);
    await command(buildProviderCommands(services), "auth").run("", rerun.shell);
    expect(rerun.selects[1]?.options.find((option) => option.value === "elevenlabs")?.hint).toBe(
      "configured",
    );
  });

  it("stores Codex browser OAuth through the broker without rendering tokens", async () => {
    const fixture = await testServices();
    const services: ProviderServices = {
      ...fixture.services,
      oauth: { ...fixture.services.oauth, codexBrowser: async () => oauthCredential },
    };
    const view = testShell(["codex", "browser", "done"]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(fixture.credentials.get("openai-codex")).toEqual(oauthCredential);
    expect(fixture.notifications.count).toBe(1);
    expect(rendered(view)).toContain("ChatGPT subscription connected");
    expect(rendered(view)).not.toContain(oauthCredential.access);
    expect(rendered(view)).not.toContain(oauthCredential.refresh);
  });

  it("supports the Codex headless device path without retaining codes in the transcript", async () => {
    const fixture = await testServices();
    const services: ProviderServices = {
      ...fixture.services,
      oauth: {
        ...fixture.services.oauth,
        codexDevice: async (options) => {
          options.onUserCode("ABCD-EFGH", "https://auth.openai.test/device");
          return oauthCredential;
        },
      },
    };
    const view = testShell(["codex", "device", "done"]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(view.statuses).toContain(
      "Visit https://auth.openai.test/device and enter code ABCD-EFGH (/cancel to abort)",
    );
    expect(view.results.every((result) => !result.text.includes("ABCD-EFGH"))).toBe(true);
    expect(fixture.credentials.get("openai-codex")).toEqual(oauthCredential);
    expect(fixture.notifications.count).toBe(1);
  });

  it("runs Anthropic browser login with masked code entry and broker persistence", async () => {
    const fixture = await testServices();
    const pastedCode = "authorization-code#returned-state";
    const services: ProviderServices = {
      ...fixture.services,
      oauth: {
        ...fixture.services.oauth,
        anthropicBrowser: async (options) => {
          const code = await options.readCode({
            state: "expected-state",
            verifier: "pkce-verifier",
            url: "https://claude.ai/oauth/authorize?state=expected-state",
          });
          expect(code).toBe(pastedCode);
          await options.store.set("anthropic", oauthCredential);
        },
      },
    };
    const view = testShell(["anthropic-oauth", "browser", "done"], [pastedCode]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(fixture.credentials.get("anthropic")).toEqual(oauthCredential);
    expect(rendered(view)).toContain("Claude Pro / Max subscription connected");
    expect(rendered(view)).not.toContain(pastedCode);
    expect(rendered(view)).not.toContain(oauthCredential.access);
  });

  it("exposes Anthropic's non-secret authorization URL for remote terminals", async () => {
    const fixture = await testServices();
    const authorizationUrl = "https://claude.ai/oauth/authorize?state=public-request-state";
    const services: ProviderServices = {
      ...fixture.services,
      oauth: {
        ...fixture.services.oauth,
        anthropicBrowser: async (options) => {
          options.openUrl?.(authorizationUrl);
          await options.readCode({ state: "state", verifier: "verifier", url: authorizationUrl });
          await options.store.set("anthropic", oauthCredential);
        },
      },
    };
    const view = testShell(["anthropic-oauth", "manual", "done"], ["authorization-code#state"]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(view.results.some((result) => result.text.includes(authorizationUrl))).toBe(true);
    expect(fixture.credentials.get("anthropic")).toEqual(oauthCredential);
  });

  it("does not render provider errors that may contain secret material", async () => {
    const fixture = await testServices();
    const leaked = "provider-error-contained-secret-token";
    const services: ProviderServices = {
      ...fixture.services,
      oauth: {
        ...fixture.services.oauth,
        codexBrowser: async () => {
          throw new Error(leaked);
        },
      },
    };
    const view = testShell(["codex", "browser", "done"]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(rendered(view)).toContain("No credential was stored");
    expect(rendered(view)).not.toContain(leaked);
    expect(fixture.credentials.size).toBe(0);
  });

  it("stores SuperGrok device OAuth through the broker without retaining codes", async () => {
    const fixture = await testServices();
    const services: ProviderServices = {
      ...fixture.services,
      oauth: {
        ...fixture.services.oauth,
        xaiDevice: async (options) => {
          options.onUserCode("WXYZ-1234", "https://auth.x.ai/activate");
          return oauthCredential;
        },
      },
    };
    const view = testShell(["xai-oauth", "done"]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(view.statuses).toContain(
      "Visit https://auth.x.ai/activate and enter code WXYZ-1234 (/cancel to abort)",
    );
    expect(view.results.every((result) => !result.text.includes("WXYZ-1234"))).toBe(true);
    expect(fixture.credentials.get("xai")).toEqual(oauthCredential);
    expect(rendered(view)).toContain("SuperGrok / X Premium connected");
    expect(rendered(view)).not.toContain(oauthCredential.access);
  });

  it("removes only the local broker credential and explains remote revocation", async () => {
    const fixture = await testServices();
    fixture.credentials.set("openai-codex", oauthCredential);
    const view = testShell(["remove", "openai-codex", "yes", "done"]);

    await command(buildProviderCommands(fixture.services), "auth").run("", view.shell);

    expect(fixture.credentials.has("openai-codex")).toBe(false);
    expect(fixture.notifications.count).toBe(1);
    expect(rendered(view)).toContain("Provider-side OAuth grants are not revoked");
  });
});

describe("provider and model commands", () => {
  it("uses Pi as the captain model and effort catalog", async () => {
    const fixture = await testServices({
      captainModels: {
        providers: () => Promise.resolve([{ id: "pi-provider", name: "Pi Provider" }]),
        models: () =>
          Promise.resolve([
            {
              id: "pi-model",
              name: "Pi Model",
              reasoning: true,
              tool_call: true,
              temperature: true,
              attachment: false,
              limit: { context: 200_000, output: 16_000 },
            },
          ]),
        thinkingLevels: () => Promise.resolve(["off", "low", "high"]),
        resolveSelection: () =>
          Promise.resolve({ model: {} as never, ref: "pi-provider/pi-model", thinkingLevel: "high" }),
        refresh: () => Promise.resolve(),
        register: () => Promise.resolve(),
      },
    });
    const commands = buildProviderCommands(fixture.services);
    const modelView = testShell(["pi-provider", "pi-model"]);

    await command(commands, "provider").run("", modelView.shell);
    await command(commands, "model").run("", modelView.shell);

    expect(modelView.selects[0]?.options.map((option) => option.value)).toEqual(["pi-provider"]);
    expect(modelView.selects[1]?.options.map((option) => option.value)).toEqual(["pi-model"]);
    const effortView = testShell(["high"]);
    await command(commands, "effort").run("", effortView.shell);
    expect(effortView.selects[0]?.options.map((option) => option.value)).toEqual([
      "off",
      "low",
      "high",
      "__clear__",
    ]);
    expect((await loadConfig({ cwd: fixture.services.cwd, env: fixture.env })).config.variant).toEqual({
      "pi-provider/pi-model": "high",
    });
  });

  it("applies provider allowlists to Pi's catalog", async () => {
    const fixture = await testServices();
    await updateGlobalConfig((config) => void (config.enabled_providers = ["beta"]), {
      env: fixture.env,
    });
    const view = testShell(["beta"]);

    await command(buildProviderCommands(fixture.services), "provider").run("", view.shell);

    expect(view.selects[0]?.options.map((option) => option.value)).toEqual(["beta"]);
  });

  it("adds a local endpoint from the provider modal and keeps per-model context", async () => {
    const fixture = await testServices({
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: "qwen3:8b" }, { id: "gpt-oss:20b", max_context_length: 131_072 }],
            }),
            { status: 200 },
          ),
        ),
    });
    const view = testShell(["__local__", "ollama"], [], ["ollama", "http://localhost:11434/v1", "32768"]);

    await command(buildProviderCommands(fixture.services), "provider").run("", view.shell);

    const { config } = await loadConfig({ cwd: fixture.services.cwd, env: fixture.env });
    const provider = config.provider?.["ollama"];
    expect(provider?.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider?.options).toEqual({ baseURL: "http://localhost:11434/v1" });
    expect(provider?.models).toEqual({
      "qwen3:8b": { tool_call: true, limit: { context: 32_768, output: 8_192 } },
      "gpt-oss:20b": { tool_call: true, limit: { context: 131_072, output: 8_192 } },
    });
    // Back on the picker, the endpoint is selectable without leaving the modal.
    expect(view.selects[1]?.options.map((option) => option.value)).toContain("ollama");
    expect(rendered(view)).toContain("clankie restart captain");
  });

  it("falls back to typed model ids when the local endpoint is unreachable", async () => {
    const fixture = await testServices({ fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) });
    const view = testShell(
      ["__local__", "lmstudio-local"],
      [],
      ["lmstudio-local", "http://127.0.0.1:1234/v1", "qwen3:8b, , mistral", "8192"],
    );

    await command(buildProviderCommands(fixture.services), "provider").run("", view.shell);

    const { config } = await loadConfig({ cwd: fixture.services.cwd, env: fixture.env });
    expect(config.provider?.["lmstudio-local"]?.models).toEqual({
      "qwen3:8b": { tool_call: true, limit: { context: 8_192, output: 2_048 } },
      mistral: { tool_call: true, limit: { context: 8_192, output: 2_048 } },
    });
    expect(rendered(view)).toContain("Could not reach http://127.0.0.1:1234/v1");
  });

  it("separates provider intent from the authoritative model write", async () => {
    const { changed, env, services } = await testServices();
    const commands = buildProviderCommands(services);
    const view = testShell(["beta", "beta-two"]);

    await command(commands, "provider").run("", view.shell);

    expect(view.selects[0]?.message).toContain("Provider for model");
    expect((await loadConfig({ cwd: services.cwd, env })).config.model).toBeUndefined();
    expect(view.results.at(-1)?.text).toContain("Run /model to choose the actual model");

    await command(commands, "provider").run("status", view.shell);
    expect(view.results.at(-1)?.text).toContain("beta · needs /auth (pending /model; configured unset)");

    await command(commands, "model").run("", view.shell);

    expect(view.selects).toHaveLength(2);
    expect(view.selects[1]?.message).toContain("Model from Beta Provider");
    expect(view.selects[1]?.options.map((option) => option.value)).toEqual(["beta-one", "beta-two"]);
    expect((await loadConfig({ cwd: services.cwd, env })).config.model).toBe("beta/beta-two");
    expect(changed).toEqual(["beta/beta-two"]);
  });

  it("labels xAI as SuperGrok or API key instead of a bare connected", async () => {
    const fixture = await testServices();
    fixture.credentials.set("xai", oauthCredential);
    const commands = buildProviderCommands(fixture.services);
    const view = testShell(["xai"]);

    await command(commands, "provider").run("", view.shell);

    expect(view.selects[0]?.options.find((option) => option.value === "xai")?.hint).toMatch(
      /^SuperGrok subscription/,
    );
    expect(view.results.at(-1)?.text).toContain("set to xai (SuperGrok subscription");
    expect(view.results.at(-1)?.text).not.toContain("connected");
  });

  it("derives provider context from the configured model after restart", async () => {
    const { env, services } = await testServices();
    await updateGlobalConfig(
      (config) => {
        config.model = "alpha/alpha-one";
      },
      { env },
    );
    const commands = buildProviderCommands(services);
    const view = testShell(["alpha-one"]);

    await command(commands, "model").run("", view.shell);

    expect(view.selects).toHaveLength(1);
    expect(view.selects[0]?.message).toContain("Model from Alpha Provider");
    expect(view.selects[0]?.options.map((option) => option.value)).toEqual(["alpha-one"]);
  });

  it("lists models from the synthetic ChatGPT subscription provider", async () => {
    const { env, services } = await testServices();
    await updateGlobalConfig(
      (config) => {
        config.model = "openai-codex/gpt-5.5";
      },
      { env },
    );
    const view = testShell(["gpt-5.5"]);

    await command(buildProviderCommands(services), "model").run("", view.shell);

    expect(view.selects).toHaveLength(1);
    expect(view.selects[0]?.message).toContain("Model from OpenAI · ChatGPT subscription");
    expect(view.selects[0]?.options.map((option) => option.value)).toEqual(["gpt-5.5"]);
    expect((await loadConfig({ cwd: services.cwd, env })).config.model).toBe("openai-codex/gpt-5.5");
  });

  it("requires /provider before /model when no configured ref exists", async () => {
    const { services } = await testServices();
    const view = testShell([]);

    await command(buildProviderCommands(services), "model").run("", view.shell);

    expect(view.selects).toEqual([]);
    expect(view.results.at(-1)).toMatchObject({ command: "/model", tone: "error" });
    expect(view.results.at(-1)?.text).toContain("run /provider first");
  });

  it("refreshes Pi's catalog from the model picker without reopening provider selection", async () => {
    const { env, refreshes, services } = await testServices();
    await updateGlobalConfig(
      (config) => {
        config.model = "alpha/alpha-one";
      },
      { env },
    );
    const view = testShell(["__refresh__", "alpha-one"]);

    await command(buildProviderCommands(services), "model").run("", view.shell);

    expect(refreshes.count).toBe(1);
    expect(view.selects).toHaveLength(2);
    expect(view.selects.every((request) => request.message.includes("Model from Alpha Provider"))).toBe(true);
    expect(view.selects[0]?.statusActions?.map((option) => option.value)).toContain("__refresh__");
  });

  it("releases committed provider intent so another face's later config becomes authoritative", async () => {
    const { env, services } = await testServices();
    const commands = buildProviderCommands(services);
    const first = testShell(["beta", "beta-one"]);
    await command(commands, "provider").run("", first.shell);
    await command(commands, "model").run("", first.shell);

    await updateGlobalConfig(
      (config) => {
        config.model = "alpha/alpha-one";
      },
      { env },
    );
    const afterExternalChange = testShell(["alpha-one"]);

    await command(commands, "model").run("", afterExternalChange.shell);

    expect(afterExternalChange.selects[0]?.message).toContain("Model from Alpha Provider");
    expect(afterExternalChange.selects[0]?.options.map((option) => option.value)).toEqual(["alpha-one"]);
  });
});

describe("model banner", () => {
  it("renders the effective runtime ref and clamped effort instead of raw config", async () => {
    const captainModels = {
      resolveSelection: () =>
        Promise.resolve({
          model: {} as never,
          ref: "openai-codex/gpt-5.6-sol",
          thinkingLevel: "high" as const,
        }),
    };
    const config = {
      model: "openai/gpt-5.6",
      variant: { "openai/gpt-5.6": "low", "openai-codex/gpt-5.6-sol": "xhigh" },
    };

    await expect(formatModelBanner(config, captainModels)).resolves.toBe(
      "openai-codex/gpt-5.6-sol (high effort)",
    );
    await expect(formatModelBanner({}, captainModels)).resolves.toBeUndefined();
  });
});
