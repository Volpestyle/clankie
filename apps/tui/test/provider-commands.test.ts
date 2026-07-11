import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, ProviderCredential } from "@sapling/credential-broker";
import { CatalogSchema, type Catalog, type ModelRegistry, type RefreshResult } from "@sapling/model-registry";
import { loadConfig, updateGlobalConfig } from "@sapling/model-provider";
import { afterEach, describe, expect, it } from "vitest";
import { buildProviderCommands, type ProviderServices } from "../src/provider-commands.ts";
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

function credentialStore(): CredentialStore {
  const values = new Map<string, ProviderCredential>();
  return {
    async delete(providerId) {
      return values.delete(providerId);
    },
    async get(providerId) {
      return values.get(providerId);
    },
    async list() {
      return {};
    },
    async set(providerId, credential) {
      values.set(providerId, credential);
    },
  };
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

function testShell(selections: Array<string[] | undefined>): {
  readonly results: CommandResult[];
  readonly selects: SelectRequest[];
  readonly shell: ClankieFaceShell;
} {
  const selects: SelectRequest[] = [];
  const results: CommandResult[] = [];
  const flow: SetupFlow = {
    begin: () => {},
    end: () => {},
    readSelect: async (options) => {
      selects.push(options);
      return selections.shift();
    },
    readText: async () => undefined,
    renderLine: () => {},
    renderOutput: () => {},
    setStatus: () => {},
    waitForInterrupt: () => ({ promise: new Promise<void>(() => {}), dispose: () => {} }),
  };
  const shell = {
    setupFlow: flow,
    insertCommandResult(command: string, text: string, tone: string): void {
      results.push({ command, text, tone });
    },
  } as unknown as ClankieFaceShell;
  return { results, selects, shell };
}

async function testServices(
  options: {
    readonly refreshResult?: RefreshResult;
  } = {},
): Promise<{
  readonly changed: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly refreshes: { count: number };
  readonly services: ProviderServices;
}> {
  const root = await mkdtemp(join(tmpdir(), "clankie-provider-commands-"));
  tempDirs.push(root);
  const env = { XDG_CONFIG_HOME: join(root, "config") };
  const changed: string[] = [];
  const refreshes = { count: 0 };
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
      store: credentialStore(),
    },
  };
}

function command(commands: readonly FaceShellCommand[], name: string): FaceShellCommand {
  const found = commands.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing /${name} command`);
  return found;
}

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
