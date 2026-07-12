import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactCredential, type CredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { CatalogSchema, type Catalog, type ModelRegistry, type RefreshResult } from "@clankie/model-registry";
import { loadConfig, updateGlobalConfig } from "@clankie/model-provider";
import { afterEach, describe, expect, it } from "vitest";
import { buildProviderCommands, validateApiKey, type ProviderServices } from "../src/provider-commands.ts";
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
  selections: Array<string[] | undefined>,
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
    renderOutput: () => {},
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
    readonly refreshResult?: RefreshResult;
  } = {},
): Promise<{
  readonly changed: string[];
  readonly credentials: Map<string, ProviderCredential>;
  readonly env: NodeJS.ProcessEnv;
  readonly refreshes: { count: number };
  readonly services: ProviderServices;
}> {
  const root = await mkdtemp(join(tmpdir(), "clankie-provider-commands-"));
  tempDirs.push(root);
  const env = { XDG_CONFIG_HOME: join(root, "config") };
  const changed: string[] = [];
  const refreshes = { count: 0 };
  const credentials = credentialStore();
  const registry: ModelRegistry = {
    async catalog() {
      return catalog();
    },
    async refresh() {
      refreshes.count += 1;
      return options.refreshResult ?? { source: "network", updated: true };
    },
  };
  return {
    changed,
    env,
    refreshes,
    services: {
      cwd: root,
      env,
      onConfigChanged(config) {
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
    const view = testShell([]);

    await command(buildProviderCommands(services), "auth").run("status", view.shell);

    expect(rendered(view)).toContain("openai · api key sk-l…");
    expect(rendered(view)).toContain("openai-codex · oauth (account-safe-summary)");
    expect(rendered(view)).not.toContain("sk-live-secret-value");
    expect(rendered(view)).not.toContain(oauthCredential.access);
    expect(rendered(view)).not.toContain(oauthCredential.refresh);
  });

  it("validates API keys through masked input and stores only through the broker", async () => {
    const { credentials, services } = await testServices();
    const secret = "sk-valid-api-key";
    const view = testShell([["api"], ["openai"], ["done"]], ["short", secret]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(view.secrets.map((request) => request.error)).toEqual([
      "That doesn't look like an API key.",
      undefined,
    ]);
    expect(credentials.get("openai")).toEqual({ type: "api", key: secret });
    expect(rendered(view)).not.toContain(secret);
    expect(validateApiKey("key with whitespace")).toBe("API keys cannot contain whitespace.");
  });

  it("stores Codex browser OAuth through the broker without rendering tokens", async () => {
    const fixture = await testServices();
    const services: ProviderServices = {
      ...fixture.services,
      oauth: { ...fixture.services.oauth, codexBrowser: async () => oauthCredential },
    };
    const view = testShell([["codex"], ["browser"], ["done"]]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(fixture.credentials.get("openai-codex")).toEqual(oauthCredential);
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
    const view = testShell([["codex"], ["device"], ["done"]]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(view.statuses).toContain(
      "Visit https://auth.openai.test/device and enter code ABCD-EFGH (/cancel to abort)",
    );
    expect(view.results.every((result) => !result.text.includes("ABCD-EFGH"))).toBe(true);
    expect(fixture.credentials.get("openai-codex")).toEqual(oauthCredential);
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
    const view = testShell([["anthropic-oauth"], ["browser"], ["done"]], [pastedCode]);

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
    const view = testShell([["anthropic-oauth"], ["manual"], ["done"]], ["authorization-code#state"]);

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
    const view = testShell([["codex"], ["browser"], ["done"]]);

    await command(buildProviderCommands(services), "auth").run("", view.shell);

    expect(rendered(view)).toContain("No credential was stored");
    expect(rendered(view)).not.toContain(leaked);
    expect(fixture.credentials.size).toBe(0);
  });

  it("removes only the local broker credential and explains remote revocation", async () => {
    const fixture = await testServices();
    fixture.credentials.set("anthropic", oauthCredential);
    const view = testShell([["remove"], ["anthropic"], ["yes"], ["done"]]);

    await command(buildProviderCommands(fixture.services), "auth").run("", view.shell);

    expect(fixture.credentials.has("anthropic")).toBe(false);
    expect(rendered(view)).toContain("Provider-side OAuth grants are not revoked");
  });
});

describe("provider and model commands", () => {
  it("separates provider intent from the authoritative model write", async () => {
    const { changed, env, services } = await testServices();
    const commands = buildProviderCommands(services);
    const view = testShell([["beta"], ["beta-two"]]);

    await command(commands, "provider").run("", view.shell);

    expect(view.selects[0]?.message).toContain("Provider for model");
    expect((await loadConfig({ cwd: services.cwd, env })).config.model).toBeUndefined();
    expect(view.results.at(-1)?.text).toContain("Run /model to choose the actual model");

    await command(commands, "provider").run("status", view.shell);
    expect(view.results.at(-1)?.text).toContain("beta (pending /model; configured unset)");

    await command(commands, "model").run("", view.shell);

    expect(view.selects).toHaveLength(2);
    expect(view.selects[1]?.message).toContain("Model from Beta Provider");
    expect(view.selects[1]?.options.map((option) => option.value)).toEqual(["beta-one", "beta-two"]);
    expect((await loadConfig({ cwd: services.cwd, env })).config.model).toBe("beta/beta-two");
    expect(changed).toEqual(["beta/beta-two"]);
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
    const view = testShell([["alpha-one"]]);

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
    const view = testShell([["gpt-5.5"]]);

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

  it("refreshes the registry from the model picker without reopening provider selection", async () => {
    const { env, refreshes, services } = await testServices();
    await updateGlobalConfig(
      (config) => {
        config.model = "alpha/alpha-one";
      },
      { env },
    );
    const view = testShell([["__refresh__"], ["alpha-one"]]);

    await command(buildProviderCommands(services), "model").run("", view.shell);

    expect(refreshes.count).toBe(1);
    expect(view.selects).toHaveLength(2);
    expect(view.selects.every((request) => request.message.includes("Model from Alpha Provider"))).toBe(true);
    expect(view.selects[0]?.statusActions?.map((option) => option.value)).toContain("__refresh__");
  });

  it("releases committed provider intent so another face's later config becomes authoritative", async () => {
    const { env, services } = await testServices();
    const commands = buildProviderCommands(services);
    const first = testShell([["beta"], ["beta-one"]]);
    await command(commands, "provider").run("", first.shell);
    await command(commands, "model").run("", first.shell);

    await updateGlobalConfig(
      (config) => {
        config.model = "alpha/alpha-one";
      },
      { env },
    );
    const afterExternalChange = testShell([["alpha-one"]]);

    await command(commands, "model").run("", afterExternalChange.shell);

    expect(afterExternalChange.selects[0]?.message).toContain("Model from Alpha Provider");
    expect(afterExternalChange.selects[0]?.options.map((option) => option.value)).toEqual(["alpha-one"]);
  });
});
