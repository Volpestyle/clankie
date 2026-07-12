/**
 * Provider/model configuration wizards: /auth, /provider, /model, /effort (VUH-760).
 * Guided SetupFlow modals over the registry (@clankie/model-registry), the
 * credential broker, and clankie.json (@clankie/model-provider). Secrets go
 * only to the credential store and render only redacted.
 */
import {
  createDefaultCredentialStore,
  type CredentialStore,
  type RedactedCredential,
} from "@clankie/credential-broker";
import {
  contextWindow,
  createModelRegistry,
  listModels,
  supportsReasoning,
  type Catalog,
  type ModelEntry,
} from "@clankie/model-registry";
import {
  ANTHROPIC_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  effortVariantsFor,
  formatModelRef,
  loadConfig,
  mergedCatalog,
  parseModelRef,
  resolveProviders,
  resolveRole,
  runAnthropicBrowserLogin,
  runCodexBrowserLogin,
  runCodexDeviceLogin,
  updateGlobalConfig,
  type ClankieConfig,
} from "@clankie/model-provider";
import type { MenuOption, SetupFlow } from "./shell/setup-flow.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface ProviderServices {
  readonly store: CredentialStore;
  readonly registry: ReturnType<typeof createModelRegistry>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly oauth: {
    readonly anthropicBrowser: typeof runAnthropicBrowserLogin;
    readonly codexBrowser: typeof runCodexBrowserLogin;
    readonly codexDevice: typeof runCodexDeviceLogin;
  };
  /** Called after config changes so the shell can refresh banner/status. */
  readonly onConfigChanged: (config: ClankieConfig) => void;
}

export function createProviderServices(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onConfigChanged?: (config: ClankieConfig) => void;
}): ProviderServices {
  const env = options.env ?? process.env;
  return {
    store: createDefaultCredentialStore({ env }),
    registry: createModelRegistry({ env }),
    env,
    cwd: options.cwd ?? process.cwd(),
    oauth: {
      anthropicBrowser: runAnthropicBrowserLogin,
      codexBrowser: runCodexBrowserLogin,
      codexDevice: runCodexDeviceLogin,
    },
    onConfigChanged: options.onConfigChanged ?? (() => {}),
  };
}

/** Providers surfaced first in /auth — everything else reachable via "other". */
const FEATURED_PROVIDERS = ["anthropic", "openai", "xai", "google", "openrouter", "groq", "mistral"];

const MODEL_ROLES = {
  "": "model",
  default: "model",
  main: "model",
  small: "small_model",
  voice: "voice_model",
} as const;

type RoleKey = "model" | "small_model" | "voice_model";

export function buildProviderCommands(services: ProviderServices): FaceShellCommand[] {
  const selectedProviders = new Map<RoleKey, string>();
  return [
    {
      name: "auth",
      aliases: ["login", "connect"],
      description: "Manage API keys, subscription OAuth, and harness logins",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "status") {
          await showAuthStatus(shell, services);
          return;
        }
        await runAuthWizard(shell, services);
      },
    },
    {
      name: "provider",
      aliases: [],
      description: "Choose which provider /model browses (also: /provider small)",
      argumentHint: "[small|voice|status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const arg = argument.trim().toLowerCase();
        if (arg === "status") {
          await showProviderStatus(shell, services, selectedProviders);
          return;
        }
        const role = (MODEL_ROLES as Record<string, RoleKey | undefined>)[arg];
        if (role === undefined) {
          shell.insertCommandResult("/provider", "Usage: /provider [small|voice|status]", "error");
          return;
        }
        await runProviderWizard(shell, services, role, selectedProviders);
      },
    },
    {
      name: "model",
      aliases: [],
      description: "Pick a model from the selected provider (also: /model small)",
      argumentHint: "[small|voice|status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const arg = argument.trim().toLowerCase();
        if (arg === "status") {
          await showModelStatus(shell, services);
          return;
        }
        const role = (MODEL_ROLES as Record<string, RoleKey | undefined>)[arg];
        if (role === undefined) {
          shell.insertCommandResult("/model", "Usage: /model [small|voice|status]", "error");
          return;
        }
        await runModelWizard(shell, services, role, selectedProviders);
      },
    },
    {
      name: "effort",
      aliases: ["reasoning"],
      description: "Configure reasoning effort for the current captain model",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        await runEffortWizard(shell, services);
      },
    },
  ];
}

// --- /auth ---

function describeRedacted(id: string, redacted: RedactedCredential): string {
  if (redacted.type === "api") return `${id} · api key ${redacted.key}`;
  if (redacted.type === "oauth") {
    const expiry =
      redacted.expires === 0
        ? "no expiry"
        : redacted.expires > Date.now()
          ? `refreshes ${new Date(redacted.expires).toLocaleTimeString()}`
          : "expired (auto-refreshes on use)";
    return `${id} · oauth${redacted.accountId === undefined ? "" : ` (${redacted.accountId})`} · ${expiry}`;
  }
  return `${id} · wellknown`;
}

async function showAuthStatus(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const listed = await services.store.list();
  const ids = Object.keys(listed).sort();
  const lines =
    ids.length === 0
      ? ["No credentials stored. Run /auth to add one."]
      : ids.map((id) => describeRedacted(id, listed[id] as RedactedCredential));
  lines.push("", "Worker harnesses authenticate natively: `codex login`, `claude login` (ADR 0006).");
  shell.insertCommandResult("/auth status", lines.join("\n"), "success");
}

async function runAuthWizard(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("auth");
  for (;;) {
    const listed = await services.store.list();
    const count = Object.keys(listed).length;
    const action = await flow.readSelect({
      kind: "single",
      message: `Provider auth (${count} credential${count === 1 ? "" : "s"} stored)`,
      options: [
        { value: "api", label: "Add / update API key", hint: "anthropic, openai, xai, google, …" },
        {
          value: "codex",
          label: "Connect ChatGPT subscription",
          hint: "Codex OAuth",
          description: "Reuses your ChatGPT plan for captain turns. Stored as openai-codex.",
        },
        {
          value: "anthropic-oauth",
          label: "Connect Claude Pro/Max subscription",
          hint: "Anthropic OAuth",
          description: "Manual-code PKCE sign-in; tokens stay in the credential broker.",
        },
        { value: "harness", label: "Worker harness logins", hint: "codex / claude CLIs" },
        ...(count > 0 ? [{ value: "remove", label: "Remove a credential" }] : []),
        { value: "status", label: "Show status" },
        { value: "done", label: "Done" },
      ],
      required: true,
    });
    const choice = action?.[0];
    if (choice === undefined || choice === "done") break;
    if (choice === "status") {
      await showAuthStatus(shell, services);
      continue;
    }
    if (choice === "harness") {
      shell.insertCommandResult(
        "/auth",
        [
          "Worker harnesses keep their native logins (ADR 0006):",
          "- Codex CLI: run `!codex login` (or `codex login` in any shell)",
          "- Claude Code: run `!claude login`",
          "- Pi: follows its own configuration",
          "The runner never injects raw provider secrets into workers (VUH-689).",
        ].join("\n"),
        "success",
      );
      continue;
    }
    if (choice === "api") {
      await addApiKeyFlow(shell, services);
      continue;
    }
    if (choice === "codex") {
      await codexOauthFlow(shell, services);
      continue;
    }
    if (choice === "anthropic-oauth") {
      await anthropicOauthFlow(shell, services);
      continue;
    }
    if (choice === "remove") {
      await removeCredentialFlow(shell, services);
    }
  }
  flow.end();
}

async function addApiKeyFlow(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  const catalog = await services.registry.catalog();
  const listed = await services.store.list();
  const featured: MenuOption[] = FEATURED_PROVIDERS.filter((id) => catalog[id] !== undefined).map((id) => ({
    value: id,
    label: catalog[id]?.name ?? id,
    ...(listed[id] !== undefined ? { hint: "configured" } : {}),
  }));
  const picked = await flow.readSelect({
    kind: "single",
    message: "Provider",
    options: [...featured, { value: "__other__", label: "Other…", hint: "enter a provider id" }],
    required: true,
    allowBack: true,
  });
  let providerId = picked?.[0];
  if (providerId === undefined) return;
  if (providerId === "__other__") {
    const typed = await flow.readText({
      message: "Provider id (as listed on models.dev, or a custom id for local endpoints)",
      placeholder: "e.g. openrouter, fireworks-ai, ollama",
      validate: (value) => (value.trim().length === 0 ? "Provider id is required." : undefined),
    });
    if (typed === undefined) return;
    providerId = typed.trim().toLowerCase();
  }
  const key = await flow.readSecret({
    message: `API key for ${providerId}`,
    validate: validateApiKey,
  });
  if (key === undefined) return;
  await services.store.set(providerId, { type: "api", key: key.trim() });
  flow.renderLine(`Stored API key for ${providerId}.`, "success");
  shell.insertCommandResult("/auth", `Credential stored for ${providerId} (api key, redacted).`, "success");
}

async function codexOauthFlow(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  const method = await flow.readSelect({
    kind: "single",
    message: "ChatGPT / Codex OAuth",
    options: [
      { value: "browser", label: "Browser sign-in", hint: "opens auth.openai.com, local callback" },
      { value: "device", label: "Headless device code", hint: "paste a code on another machine" },
    ],
    required: true,
    allowBack: true,
  });
  const pickedMethod = method?.[0];
  if (pickedMethod === undefined) return;
  const interrupt = flow.waitForInterrupt();
  try {
    if (pickedMethod === "browser") {
      flow.setStatus("waiting for browser sign-in… (/cancel to abort)");
      const credential = await Promise.race([
        services.oauth.codexBrowser({}),
        interrupt.promise.then(() => undefined),
      ]);
      if (credential === undefined) {
        flow.renderLine("Sign-in cancelled.", "warning");
        return;
      }
      await services.store.set(CODEX_PROVIDER_ID, credential);
    } else {
      flow.setStatus("requesting device code…");
      const credential = await Promise.race([
        services.oauth.codexDevice({
          onUserCode: (code, url) => {
            flow.setStatus(`Visit ${url} and enter code ${code} (/cancel to abort)`);
          },
        }),
        interrupt.promise.then(() => undefined),
      ]);
      if (credential === undefined) {
        flow.renderLine("Sign-in cancelled.", "warning");
        return;
      }
      await services.store.set(CODEX_PROVIDER_ID, credential);
    }
    flow.renderLine("ChatGPT subscription connected.", "success");
    shell.insertCommandResult(
      "/auth",
      `ChatGPT subscription connected (stored as ${CODEX_PROVIDER_ID}). Pick it via /provider, then /model.`,
      "success",
    );
  } catch {
    renderOauthFailure(flow, "ChatGPT");
  } finally {
    interrupt.dispose();
  }
}

class AuthFlowCancelled extends Error {}

async function anthropicOauthFlow(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  const method = await flow.readSelect({
    kind: "single",
    message: "Claude Pro / Max OAuth",
    options: [
      { value: "browser", label: "Browser sign-in", hint: "opens claude.ai" },
      {
        value: "manual",
        label: "Show authorization URL",
        hint: "headless / remote terminal",
        description: "Open the URL in any browser, then paste Anthropic's returned code.",
      },
    ],
    required: true,
    allowBack: true,
  });
  const pickedMethod = method?.[0];
  if (pickedMethod === undefined) return;

  try {
    flow.setStatus("starting Claude Pro / Max sign-in…");
    await services.oauth.anthropicBrowser({
      store: services.store,
      ...(pickedMethod === "manual"
        ? {
            openUrl: (url: string) => {
              shell.insertCommandResult(
                "/auth",
                `Open this Anthropic authorization URL in a browser:\n${url}`,
                "success",
              );
            },
          }
        : {}),
      readCode: async () => {
        const code = await flow.readSecret({
          message: "Paste the authorization-code#state value shown by Anthropic",
          allowBack: true,
          validate: validateAnthropicAuthorizationCode,
        });
        if (code === undefined) throw new AuthFlowCancelled();
        flow.setStatus("exchanging Anthropic authorization code…");
        return code.trim();
      },
    });
    flow.renderLine("Claude Pro / Max subscription connected.", "success");
    shell.insertCommandResult(
      "/auth",
      `Claude Pro / Max subscription connected (stored as ${ANTHROPIC_PROVIDER_ID}).`,
      "success",
    );
  } catch (error) {
    if (error instanceof AuthFlowCancelled) {
      flow.renderLine("Sign-in cancelled.", "warning");
      return;
    }
    renderOauthFailure(flow, "Claude Pro / Max");
  }
}

export function validateApiKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 8) return "That doesn't look like an API key.";
  if (trimmed.length > 4096) return "That API key is unexpectedly long.";
  if (/\s/u.test(trimmed)) return "API keys cannot contain whitespace.";
  return undefined;
}

function validateAnthropicAuthorizationCode(value: string): string | undefined {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("#");
  return separator <= 0 || separator === trimmed.length - 1 || trimmed.indexOf("#", separator + 1) >= 0
    ? "Paste the complete authorization-code#state value."
    : undefined;
}

function renderOauthFailure(flow: SetupFlow, provider: string): void {
  flow.renderLine(
    `${provider} sign-in failed. No credential was stored; retry or check the provider's status.`,
    "error",
  );
}

async function removeCredentialFlow(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  const listed = await services.store.list();
  const options = Object.entries(listed).map(([id, redacted]) => ({
    value: id,
    label: id,
    hint: describeRedacted(id, redacted).slice(id.length + 3),
  }));
  if (options.length === 0) return;
  const picked = await flow.readSelect({
    kind: "single",
    message: "Remove which credential?",
    options,
    required: true,
    allowBack: true,
  });
  const id = picked?.[0];
  if (id === undefined) return;
  const confirmed = await flow.readSelect({
    kind: "single",
    message: `Remove ${id}?`,
    options: [
      {
        value: "yes",
        label: "Remove local credential",
        hint: "does not revoke the provider-side OAuth grant",
      },
      { value: "no", label: "Keep" },
    ],
    required: true,
  });
  if (confirmed?.[0] !== "yes") return;
  const removed = await services.store.delete(id);
  shell.insertCommandResult(
    "/auth",
    removed
      ? `Removed the local credential for ${id}. Provider-side OAuth grants are not revoked.`
      : `No local credential was stored for ${id}.`,
    removed ? "success" : "error",
  );
}

// --- /provider + /model ---

function roleLabel(role: RoleKey): string {
  return role.replace("_", " ");
}

function modelHint(model: ModelEntry): string {
  const parts: string[] = [];
  const context = contextWindow(model);
  if (context > 0) parts.push(`${Math.round(context / 1000)}k ctx`);
  if (supportsReasoning(model)) parts.push("reasoning");
  const input = model.cost?.input;
  const output = model.cost?.output;
  if (input !== undefined && output !== undefined) parts.push(`$${input}/$${output} per M`);
  return parts.join(" · ");
}

async function showModelStatus(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const catalog = await services.registry.catalog();
  const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
  const lines: string[] = [];
  for (const role of ["model", "small_model", "voice_model"] as const) {
    const resolved = resolveRole(role, { config, catalog });
    lines.push(
      `${role}: ${
        resolved === undefined
          ? "unset"
          : `${formatModelRef(resolved)}${resolved.variantId === undefined ? "" : ` (${resolved.variantId})`}`
      }`,
    );
  }
  shell.insertCommandResult("/model status", lines.join("\n"), "success");
}

async function showProviderStatus(
  shell: ClankieFaceShell,
  services: ProviderServices,
  selectedProviders: ReadonlyMap<RoleKey, string>,
): Promise<void> {
  const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
  const lines = (["model", "small_model", "voice_model"] as const).map((role) => {
    const configured = config[role] === undefined ? undefined : parseModelRef(config[role]);
    const selected = selectedProviders.get(role) ?? configured?.providerId;
    const pending =
      selected !== undefined && selected !== configured?.providerId
        ? ` (pending /model; configured ${configured?.providerId ?? "unset"})`
        : "";
    return `${role}: ${selected ?? "unset — run /provider"}${pending}`;
  });
  shell.insertCommandResult("/provider status", lines.join("\n"), "success");
}

async function runProviderWizard(
  shell: ClankieFaceShell,
  services: ProviderServices,
  role: RoleKey,
  selectedProviders: Map<RoleKey, string>,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin(`choose provider for ${roleLabel(role)}`);
  try {
    for (;;) {
      const catalog = await services.registry.catalog();
      const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
      const credentialIds = Object.keys(await services.store.list());
      const providers = resolveProviders({ config, catalog, credentialIds, env: services.env });
      const configured = config[role] === undefined ? undefined : parseModelRef(config[role]);
      const currentProvider = selectedProviders.get(role) ?? configured?.providerId;
      const picked = await flow.readSelect({
        kind: "single",
        message: `Provider for ${roleLabel(role)} (${providers.length} available — type to filter)`,
        options: providers.map((provider) => ({
          value: provider.id,
          label: provider.name,
          hint: provider.connected ? "connected" : "needs /auth",
        })),
        statusActions: [{ value: "__refresh__", label: "refresh registry (models.dev)" }],
        ...(currentProvider === undefined ? {} : { currentValue: currentProvider }),
        required: true,
        allowBack: true,
      });
      const providerId = picked?.[0];
      if (providerId === undefined) {
        flow.end();
        shell.insertCommandResult("/provider", "Provider selection cancelled.", "error");
        return;
      }
      if (providerId === "__refresh__") {
        flow.setStatus("refreshing registry…");
        const result = await services.registry.refresh(true);
        flow.renderLine(`Registry refreshed (${result.source}).`, "success");
        continue;
      }
      selectedProviders.set(role, providerId);
      const provider = providers.find((candidate) => candidate.id === providerId);
      flow.end();
      shell.insertCommandResult(
        "/provider",
        [
          `Provider for ${roleLabel(role)} set to ${providerId}. Run /model to choose the actual model.`,
          ...(provider !== undefined && !provider.connected
            ? [`Note: ${providerId} has no credential yet — run /auth before real captain turns.`]
            : []),
        ].join("\n"),
        "success",
      );
      return;
    }
  } catch (error) {
    flow.end();
    throw error;
  }
}

async function runModelWizard(
  shell: ClankieFaceShell,
  services: ProviderServices,
  role: RoleKey,
  selectedProviders: Map<RoleKey, string>,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin(`choose ${roleLabel(role)}`);
  try {
    for (;;) {
      const catalog: Catalog = await services.registry.catalog();
      const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
      const effectiveCatalog = mergedCatalog(config, catalog);
      const credentialIds = Object.keys(await services.store.list());
      const providers = resolveProviders({ config, catalog, credentialIds, env: services.env });
      const configured = config[role] === undefined ? undefined : parseModelRef(config[role]);
      const providerId = selectedProviders.get(role) ?? configured?.providerId;
      if (providerId === undefined) {
        flow.end();
        shell.insertCommandResult(
          "/model",
          `No provider selected for ${roleLabel(role)} — run /provider${role === "model" ? "" : ` ${role === "small_model" ? "small" : "voice"}`} first.`,
          "error",
        );
        return;
      }
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (provider === undefined) {
        selectedProviders.delete(role);
        flow.end();
        shell.insertCommandResult(
          "/model",
          `Provider ${providerId} is not currently enabled — run /provider to choose another.`,
          "error",
        );
        return;
      }
      const models = listModels(effectiveCatalog, providerId);
      if (models.length === 0) {
        flow.end();
        shell.insertCommandResult(
          "/model",
          `No models listed for ${providerId} — add custom models in clankie.json or run /provider to choose another.`,
          "error",
        );
        return;
      }
      const currentRef = config[role];
      const currentParsed = currentRef === undefined ? undefined : parseModelRef(currentRef);
      const currentModelId = currentParsed?.providerId === providerId ? currentParsed.modelId : undefined;
      const pickedModel = await flow.readSelect({
        kind: "single",
        message: `Model from ${provider.name} (${models.length} listed, newest first — type to filter)`,
        options: models.map((model) => ({
          value: model.id,
          label: model.id,
          hint: modelHint(model),
          description: model.name,
        })),
        statusActions: [{ value: "__refresh__", label: "refresh registry (models.dev)" }],
        ...(currentModelId === undefined ? {} : { currentValue: currentModelId }),
        required: true,
        allowBack: true,
      });
      const modelId = pickedModel?.[0];
      if (modelId === undefined) {
        flow.end();
        shell.insertCommandResult("/model", "Model selection cancelled.", "error");
        return;
      }
      if (modelId === "__refresh__") {
        flow.setStatus("refreshing registry…");
        const result = await services.registry.refresh(true);
        flow.renderLine(`Registry refreshed (${result.source}).`, "success");
        continue;
      }
      const ref = formatModelRef({ providerId, modelId });
      const updated = await updateGlobalConfig(
        (current) => {
          current[role] = ref;
        },
        { env: services.env },
      );
      services.onConfigChanged(updated);
      selectedProviders.delete(role);
      flow.end();
      shell.insertCommandResult(
        "/model",
        [
          `${roleLabel(role)} set to ${ref}.`,
          ...(!provider.connected
            ? [`Note: ${providerId} has no credential yet — run /auth before real captain turns.`]
            : []),
        ].join("\n"),
        "success",
      );
      return;
    }
  } catch (error) {
    flow.end();
    throw error;
  }
}

// --- /effort ---

async function runEffortWizard(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  const catalog = await services.registry.catalog();
  const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
  const resolved = resolveRole("model", { config, catalog });
  if (resolved === undefined) {
    shell.insertCommandResult(
      "/effort",
      "No captain model configured — run /provider, then /model first.",
      "error",
    );
    return;
  }
  if (resolved.model === undefined || !supportsReasoning(resolved.model)) {
    shell.insertCommandResult(
      "/effort",
      `${formatModelRef(resolved)} does not support configurable reasoning.`,
      "success",
    );
    return;
  }
  const variants = effortVariantsFor(resolved.providerId, resolved.model);
  if (variants.length === 0) {
    shell.insertCommandResult("/effort", "No effort variants available for this model.", "success");
    return;
  }
  flow.begin("reasoning effort");
  const ref = formatModelRef(resolved);
  const picked = await flow.readSelect({
    kind: "single",
    message: `Reasoning effort for ${ref}`,
    options: [
      ...variants.map((variant) => ({ value: variant.id, label: variant.id })),
      { value: "__clear__", label: "default", hint: "provider default, no override" },
    ],
    ...(resolved.variantId === undefined ? {} : { currentValue: resolved.variantId }),
    required: true,
  });
  flow.end();
  const choice = picked?.[0];
  if (choice === undefined) {
    shell.insertCommandResult("/effort", "Effort selection cancelled.", "error");
    return;
  }
  const updated = await updateGlobalConfig(
    (current) => {
      const variantMap = { ...current.variant };
      if (choice === "__clear__") delete variantMap[ref];
      else variantMap[ref] = choice;
      current.variant = variantMap;
    },
    { env: services.env },
  );
  services.onConfigChanged(updated);
  shell.insertCommandResult(
    "/effort",
    choice === "__clear__" ? `Effort override cleared for ${ref}.` : `Effort set to ${choice} for ${ref}.`,
    "success",
  );
}
