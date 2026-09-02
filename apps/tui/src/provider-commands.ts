/**
 * Provider/model configuration wizards: /auth, /provider, /model, /effort (VUH-760).
 * Guided SetupFlow modals over the registry (@clankie/model-registry), the
 * credential broker, and clankie.json (@clankie/model-provider). Secrets go
 * only to the credential store and render only redacted.
 */
import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  createDefaultCredentialStore,
  DISCORD_BOT_PROVIDER_ID,
  DISCORD_USER_SESSION_PROVIDER_ID,
  LINEAR_PROVIDER_ID,
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
  type CredentialStore,
  type RedactedCredential,
} from "@clankie/credential-broker";
import { createModelRegistry, loadBundledCatalog, type ModelEntry } from "@clankie/model-registry";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ANTHROPIC_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  XAI_PROVIDER_ID,
  formatModelRef,
  loadConfig,
  LOCAL_CONTEXT_FALLBACK,
  parseModelRef,
  probeLocalModels,
  resolvePiModelSelection,
  registerConfiguredPiProviders,
  runAnthropicBrowserLogin,
  runCodexBrowserLogin,
  runCodexDeviceLogin,
  runXaiDeviceLogin,
  subscriptionRefFor,
  validateLocalBaseUrl,
  validateLocalProviderId,
  type ClankieConfig,
  type PiModelSelection,
  type ProbedLocalModel,
} from "@clankie/model-provider";
import { modelDeclareLocal, modelSet, modelStatus } from "./command/model.ts";
import { effortSet, effortStatus } from "./command/effort.ts";
import { imageModelSet, imageModelStatus } from "./command/image-model.ts";
import { videoModelSet, videoModelStatus } from "./command/video-model.ts";
import type { MenuOption, SetupFlow } from "./shell/setup-flow.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface ProviderServices {
  readonly store: CredentialStore;
  readonly registry: ReturnType<typeof createModelRegistry>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Injected fetch for local-endpoint probing; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly captainModels: {
    providers(): Promise<readonly { id: string; name: string }[]>;
    models(providerId: string): Promise<readonly ModelEntry[]>;
    thinkingLevels(providerId: string, modelId: string): Promise<readonly string[]>;
    resolveSelection(config: ClankieConfig): Promise<PiModelSelection>;
    refresh(): Promise<void>;
    /** Re-projects config-declared providers so a just-added endpoint is pickable now. */
    register(config: ClankieConfig): Promise<void>;
  };
  readonly oauth: {
    readonly anthropicBrowser: typeof runAnthropicBrowserLogin;
    readonly codexBrowser: typeof runCodexBrowserLogin;
    readonly codexDevice: typeof runCodexDeviceLogin;
    readonly xaiDevice: typeof runXaiDeviceLogin;
  };
  /** Called after config or routing-auth changes so the shell can refresh banner/status. */
  readonly onConfigChanged: (config: ClankieConfig) => void;
}

export function createProviderServices(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onConfigChanged?: (config: ClankieConfig) => void;
}): ProviderServices {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const registry = createModelRegistry({ env });
  const store = createDefaultCredentialStore({ env });
  let piRuntime: Promise<ModelRuntime> | undefined;
  const runtime = (): Promise<ModelRuntime> =>
    (piRuntime ??= (async () => {
      const created = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      const { config } = await loadConfig({ env, cwd });
      registerConfiguredPiProviders(created, config, await registry.catalog());
      return created;
    })());
  return {
    store,
    registry,
    env,
    cwd,
    captainModels: {
      async providers() {
        return (await runtime()).getProviders().map(({ id, name }) => ({ id, name }));
      },
      async models(providerId) {
        return (await runtime()).getModels(providerId).map(piModelEntry);
      },
      async thinkingLevels(providerId, modelId) {
        const model = (await runtime()).getModel(providerId, modelId);
        return model === undefined ? [] : getSupportedThinkingLevels(model);
      },
      async resolveSelection(config) {
        return resolvePiModelSelection(
          config,
          await runtime(),
          (await store.get(CODEX_PROVIDER_ID)) !== undefined,
        );
      },
      async refresh() {
        await (await runtime()).refresh({ allowNetwork: true, force: true });
      },
      async register(config) {
        registerConfiguredPiProviders(await runtime(), config, await registry.catalog());
      },
    },
    oauth: {
      anthropicBrowser: runAnthropicBrowserLogin,
      codexBrowser: runCodexBrowserLogin,
      codexDevice: runCodexDeviceLogin,
      xaiDevice: runXaiDeviceLogin,
    },
    onConfigChanged: options.onConfigChanged ?? (() => {}),
  };
}

function piModelEntry(model: Model<any>): ModelEntry {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    tool_call: true,
    temperature: true,
    attachment: model.input.includes("image"),
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache_read: model.cost.cacheRead,
      cache_write: model.cost.cacheWrite,
    },
    limit: { context: model.contextWindow, output: model.maxTokens },
    modalities: { input: model.input, output: ["text"] },
  };
}

/** Providers surfaced first in /auth — everything else reachable via "other". */
const FEATURED_PROVIDERS = ["anthropic", "openai", "xai", "google", "openrouter", "groq", "mistral"];

/**
 * Non-LLM credentials that are still first-class /auth citizens. These serve
 * voice or other services, so they are absent from the models.dev catalog and
 * cannot ride the FEATURED_PROVIDERS catalog filter above.
 */
const FEATURED_SERVICE_PROVIDERS: readonly MenuOption[] = [
  {
    value: "elevenlabs",
    label: "ElevenLabs",
    description: "Voice TTS for Discord (ADR 0070); pick the voice itself with /voice.",
  },
];

/** Owner-authored non-LLM credentials that share the broker with /auth. */
const SERVICE_CREDENTIAL_IDS = new Set([
  DISCORD_BOT_PROVIDER_ID,
  DISCORD_USER_SESSION_PROVIDER_ID,
  "elevenlabs",
  "email",
  LINEAR_PROVIDER_ID,
  CLANKIE_ACCOUNT_PROVIDER_ID,
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
]);

/** First-class /auth slots always shown on status, stored or missing. */
const AUTH_STATUS_PROVIDER_IDS: readonly string[] = FEATURED_PROVIDERS.flatMap((id) =>
  id === "openai" ? [id, CODEX_PROVIDER_ID] : [id],
);
const AUTH_STATUS_SERVICE_IDS: readonly string[] = [
  CLANKIE_ACCOUNT_PROVIDER_ID,
  ...FEATURED_SERVICE_PROVIDERS.map((option) => option.value),
  DISCORD_BOT_PROVIDER_ID,
];

export function buildProviderCommands(services: ProviderServices): FaceShellCommand[] {
  let selectedProvider: string | undefined;
  return [
    {
      name: "auth",
      aliases: ["login"],
      description: "Manage API keys, subscription OAuth, and harness logins",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const selector = argument.trim().toLowerCase();
        if (selector === "status") {
          await showAuthStatus(shell, services);
          return;
        }
        if (selector === "mcp" || selector.startsWith("mcp ")) {
          shell.insertCommandResult(
            "/auth mcp",
            "Service connections moved to /connect (linear, email, discord). /auth stays provider keys and subscriptions.",
            "success",
          );
          return;
        }
        await runAuthWizard(shell, services);
      },
    },
    {
      name: "provider",
      aliases: [],
      description: "Choose which provider /model browses",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const arg = argument.trim().toLowerCase();
        if (arg === "status") {
          await showProviderStatus(shell, services, selectedProvider);
          return;
        }
        if (arg !== "" && arg !== "default" && arg !== "main") {
          shell.insertCommandResult("/provider", "Usage: /provider [status]", "error");
          return;
        }
        selectedProvider = await runProviderWizard(shell, services, selectedProvider);
      },
    },
    {
      name: "model",
      aliases: [],
      description: "Pick a model from the selected provider",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const arg = argument.trim().toLowerCase();
        if (arg === "status") {
          await showModelStatus(shell, services);
          return;
        }
        if (arg !== "" && arg !== "default" && arg !== "main") {
          shell.insertCommandResult("/model", "Usage: /model [status]", "error");
          return;
        }
        selectedProvider = await runModelWizard(shell, services, selectedProvider);
      },
    },
    mediaModelCommand("image-model", "image_model", services),
    mediaModelCommand("video-model", "video_model", services),
    {
      name: "effort",
      aliases: ["reasoning"],
      description: "Configure reasoning effort for Clankie's current model",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim().toLowerCase() === "status") {
          const result = await effortStatus({ env: services.env, cwd: services.cwd });
          shell.insertCommandResult(
            "/effort status",
            `model: ${result.model ?? "unset"}\neffort: ${result.effort ?? "default"}`,
            result.ok ? "success" : "error",
          );
          return;
        }
        await runEffortWizard(shell, services);
      },
    },
  ];
}

// --- /image-model, /video-model ---

/**
 * Which model Clankie draws and renders with (ADR 0085).
 *
 * Positional rather than a wizard, unlike `/model`: there are three providers
 * and one usable model each, so a two-step picker would be ceremony around a
 * choice that fits on one line. It writes the same config file `/model` does,
 * and the service reads it per request — no restart.
 */
const MEDIA_MODELS: Readonly<Record<"image_model" | "video_model", Readonly<Record<string, string>>>> = {
  image_model: {
    openai: "gpt-image-2",
    google: "gemini-3.1-flash-image",
    xai: "grok-imagine-image-quality",
  },
  video_model: { xai: "grok-imagine-video-1.5" },
};

function mediaModelCommand(
  name: "image-model" | "video-model",
  role: "image_model" | "video_model",
  services: ProviderServices,
): FaceShellCommand {
  const supported = MEDIA_MODELS[role];
  const providers = Object.keys(supported);
  const noun = role === "image_model" ? "pictures" : "video";
  return {
    name,
    aliases: [],
    description: `Choose the model Clankie makes ${noun} with`,
    argumentHint: `[${providers.join("|")}|status|unset]`,
    takesArgument: true,
    async run(argument, shell): Promise<void> {
      const [providerId, modelId] = argument.trim().toLowerCase().split(/\s+/u).filter(Boolean);
      const usage = `Usage: /${name} [${providers.join("|")}] [model] · /${name} status · /${name} unset`;

      if (providerId === undefined || providerId === "status") {
        const configured =
          role === "image_model"
            ? (await imageModelStatus({ env: services.env, cwd: services.cwd })).imageModel
            : (await videoModelStatus({ env: services.env, cwd: services.cwd })).videoModel;
        const credentialIds = Object.keys(await services.store.list());
        const parsed = configured === null ? undefined : parseModelRef(configured);
        const connected =
          parsed !== undefined &&
          (credentialIds.includes(parsed.providerId) ||
            providerEnvConnected(parsed.providerId, services.env));
        shell.insertCommandResult(
          `/${name} status`,
          [
            `${role}: ${configured ?? "unset"}`,
            ...(parsed === undefined
              ? []
              : [
                  connected
                    ? "credential: stored"
                    : `credential: missing — run /auth for ${parsed.providerId}`,
                ]),
            "",
            usage,
          ].join("\n"),
          "success",
        );
        return;
      }

      if (providerId === "unset") {
        if (role === "image_model") await imageModelSet(null, { env: services.env });
        else await videoModelSet(null, { env: services.env });
        await notifyModelSelectionChanged(services);
        shell.insertCommandResult(`/${name} unset`, `${role} cleared.`, "success");
        return;
      }

      const fallback = supported[providerId];
      if (fallback === undefined) {
        shell.insertCommandResult(`/${name}`, `${providerId} has no media adapter.\n\n${usage}`, "error");
        return;
      }
      // The named model wins so a provider's newer id works the day it ships,
      // without waiting on a catalog refresh; the default is what this
      // repository's adapters are known to speak.
      const ref = `${providerId}/${modelId ?? fallback}`;
      if (role === "image_model") await imageModelSet(ref, { env: services.env });
      else await videoModelSet(ref, { env: services.env });
      await notifyModelSelectionChanged(services);
      const credentialIds = Object.keys(await services.store.list());
      const needsAuth =
        !credentialIds.includes(providerId) && !providerEnvConnected(providerId, services.env);
      shell.insertCommandResult(
        `/${name}`,
        `${role} set to ${ref}.${needsAuth ? `\n\nNo credential stored for ${providerId} — run /auth.` : ""}`,
        "success",
      );
    },
  };
}

function providerEnvConnected(providerId: string, env: NodeJS.ProcessEnv): boolean {
  return (loadBundledCatalog()[providerId]?.env ?? []).some((variable) => (env[variable] ?? "") !== "");
}

/** Same wording as `/auth status`, so `/provider` shows SuperGrok vs API key. */
function providerConnectionHint(
  id: string,
  listed: Record<string, RedactedCredential>,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): string {
  const redacted = listed[id];
  if (redacted !== undefined) return describeCredentialKind(id, redacted, now);
  if (providerEnvConnected(id, env)) return "env";
  return "needs /auth";
}

// --- /auth ---

/** Broker-minted local bearers (`clankie_operator`, bridges, …). Not operator-authored. */
function isLocalIdentity(providerId: string): boolean {
  return providerId.startsWith("clankie_");
}

function isServiceCredential(providerId: string): boolean {
  return SERVICE_CREDENTIAL_IDS.has(providerId);
}

function ownerCredentialEntries(
  listed: Record<string, RedactedCredential>,
): Array<[string, RedactedCredential]> {
  return Object.entries(listed)
    .filter(([id]) => !isLocalIdentity(id))
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * The banner's model line comes from the same effective Pi selection the
 * captain uses, after subscription routing, variant precedence, and clamping.
 */
export async function formatModelBanner(
  config: ClankieConfig,
  captainModels: Pick<ProviderServices["captainModels"], "resolveSelection">,
): Promise<string | undefined> {
  if (config.model === undefined) return undefined;
  const selection = await captainModels.resolveSelection(config);
  return `${selection.ref} (${selection.thinkingLevel} effort)`;
}

/**
 * Operator-facing /auth status. Lists first-class slots even when empty, omits
 * auto-minted `clankie_*` process identities, and never reprints secret prefixes.
 */
export function formatAuthStatus(
  listed: Record<string, RedactedCredential>,
  options: { now?: number; envConnected?: ReadonlySet<string> | readonly string[] } = {},
): string {
  const now = options.now ?? Date.now();
  const envConnected = new Set(options.envConnected ?? []);
  const listedIds = Object.keys(listed);
  const providers = checklistIds(AUTH_STATUS_PROVIDER_IDS, listedIds, (id) => {
    return !isLocalIdentity(id) && !isServiceCredential(id);
  });
  const services = checklistIds(AUTH_STATUS_SERVICE_IDS, listedIds, isServiceCredential);
  return [
    "providers:",
    ...alignStatusRows(providers.map((id) => ({ id, detail: statusDetail(id, listed, envConnected, now) }))),
    "",
    "services:",
    ...alignStatusRows(services.map((id) => ({ id, detail: statusDetail(id, listed, envConnected, now) }))),
    "",
    "Worker harnesses keep their own logins (`codex login`, `claude login`).",
  ].join("\n");
}

function checklistIds(
  expected: readonly string[],
  listedIds: readonly string[],
  belong: (id: string) => boolean,
): string[] {
  const extras = listedIds.filter((id) => belong(id) && !expected.includes(id)).sort();
  return [...expected, ...extras];
}

function statusDetail(
  id: string,
  listed: Record<string, RedactedCredential>,
  envConnected: ReadonlySet<string>,
  now: number,
): string {
  const redacted = listed[id];
  if (redacted !== undefined) return describeCredentialKind(id, redacted, now);
  if (envConnected.has(id)) return "env";
  return "missing";
}

function alignStatusRows(rows: ReadonlyArray<{ id: string; detail: string }>): string[] {
  const width = Math.max(...rows.map((row) => row.id.length));
  return rows.map((row) => `  ${row.id.padEnd(width)}  ${row.detail}`);
}

function describeCredentialKind(id: string, redacted: RedactedCredential, now: number = Date.now()): string {
  if (redacted.type === "wellknown") return "well-known";
  if (redacted.type === "api") {
    if (id === DISCORD_BOT_PROVIDER_ID) return "bot token";
    if (id === DISCORD_USER_SESSION_PROVIDER_ID) return "user token";
    if (id === "email") return "app password";
    return "API key";
  }
  const account = formatOauthAccount(redacted.accountId);
  const expiry = formatOauthExpiry(redacted.expires, now);
  if (id === CODEX_PROVIDER_ID) return `ChatGPT subscription${account} · ${expiry}`;
  if (id === ANTHROPIC_PROVIDER_ID) return `Claude subscription${account} · ${expiry}`;
  if (id === XAI_PROVIDER_ID) return `SuperGrok subscription${account} · ${expiry}`;
  return `OAuth${account} · ${expiry}`;
}

function formatOauthAccount(accountId: string | undefined): string {
  if (accountId === undefined || accountId.length === 0 || isOpaqueAccountId(accountId)) return "";
  return ` (${accountId})`;
}

function isOpaqueAccountId(accountId: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(accountId) ||
    /^acct[_-]/iu.test(accountId)
  );
}

function formatOauthExpiry(expires: number, now: number): string {
  if (expires === 0) return "no expiry";
  const delta = expires - now;
  if (delta <= 0) return "expired (refreshes on use)";
  if (delta < 60_000) return "refreshes soon";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 90) return `refreshes in ${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `refreshes in ${String(hours)}h`;
  return `refreshes in ${String(Math.round(hours / 24))}d`;
}

async function showAuthStatus(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const listed = await services.store.list();
  const catalog = await services.registry.catalog();
  const envConnected = Object.keys(catalog).filter((id) => providerEnvConnected(id, services.env));
  shell.insertCommandResult("/auth status", formatAuthStatus(listed, { envConnected }), "success");
}

async function runAuthWizard(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("auth");
  for (;;) {
    const listed = await services.store.list();
    const ownerCount = ownerCredentialEntries(listed).length;
    const action = await flow.readSelect({
      message: `Provider auth (${ownerCount} credential${ownerCount === 1 ? "" : "s"} stored)`,
      options: [
        { value: "api", label: "Add / update API key", hint: "anthropic, openai, xai, google, …" },
        {
          value: "codex",
          label: "Connect ChatGPT subscription",
          hint: "Codex OAuth",
          description: "Reuses your ChatGPT plan for Clankie's turns. Stored as openai-codex.",
        },
        {
          value: "anthropic-oauth",
          label: "Connect Claude Pro/Max subscription",
          hint: "Anthropic OAuth",
          description: "Manual-code PKCE sign-in; tokens stay in the credential broker.",
        },
        {
          value: "xai-oauth",
          label: "Connect SuperGrok / X Premium",
          hint: "xAI device code",
          description: "Uses your Grok or X Premium plan for turns, pictures, and video. Stored as xai.",
        },
        { value: "harness", label: "Worker harness logins", hint: "codex / claude CLIs" },
        ...(ownerCount > 0 ? [{ value: "remove", label: "Remove a credential" }] : []),
        { value: "status", label: "Show status" },
        { value: "done", label: "Done" },
      ],
    });
    const choice = action;
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
    if (choice === "xai-oauth") {
      await xaiOauthFlow(shell, services);
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
  const featuredServices: MenuOption[] = FEATURED_SERVICE_PROVIDERS.map((option) => ({
    ...option,
    ...(listed[option.value] !== undefined ? { hint: "configured" } : {}),
  }));
  const picked = await flow.readSelect({
    message: "Provider",
    options: [
      ...featured,
      ...featuredServices,
      { value: "__other__", label: "Other…", hint: "enter a provider id" },
    ],
    allowBack: true,
  });
  let providerId = picked;
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
  shell.insertCommandResult(
    "/auth",
    [
      `Credential stored for ${providerId} (api key, redacted).`,
      ...(providerId === "elevenlabs" ? ["Pick the ElevenLabs voice and model with /voice."] : []),
    ].join("\n"),
    "success",
  );
}

async function codexOauthFlow(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  const method = await flow.readSelect({
    message: "ChatGPT / Codex OAuth",
    options: [
      { value: "browser", label: "Browser sign-in", hint: "opens auth.openai.com, local callback" },
      { value: "device", label: "Headless device code", hint: "paste a code on another machine" },
    ],
    allowBack: true,
  });
  const pickedMethod = method;
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
    await notifyModelSelectionChanged(services);
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
    allowBack: true,
  });
  const pickedMethod = method;
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

async function xaiOauthFlow(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const flow = shell.setupFlow;
  const interrupt = flow.waitForInterrupt();
  try {
    flow.setStatus("requesting SuperGrok device code…");
    const credential = await Promise.race([
      services.oauth.xaiDevice({
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
    await services.store.set(XAI_PROVIDER_ID, credential);
    flow.renderLine("SuperGrok / X Premium connected.", "success");
    shell.insertCommandResult(
      "/auth",
      `SuperGrok / X Premium connected (stored as ${XAI_PROVIDER_ID}). Pictures and video use this credential over an API key.`,
      "success",
    );
  } catch {
    renderOauthFailure(flow, "SuperGrok / X Premium");
  } finally {
    interrupt.dispose();
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
  const options = ownerCredentialEntries(listed).map(([id, redacted]) => ({
    value: id,
    label: id,
    hint: describeCredentialKind(id, redacted),
  }));
  if (options.length === 0) return;
  const picked = await flow.readSelect({
    message: "Remove which credential?",
    options,
    allowBack: true,
  });
  const id = picked;
  if (id === undefined) return;
  const confirmed = await flow.readSelect({
    message: `Remove ${id}?`,
    options: [
      {
        value: "yes",
        label: "Remove local credential",
        hint: "does not revoke the provider-side OAuth grant",
      },
      { value: "no", label: "Keep" },
    ],
  });
  if (confirmed !== "yes") return;
  const removed = await services.store.delete(id);
  if (removed && id === CODEX_PROVIDER_ID) await notifyModelSelectionChanged(services);
  shell.insertCommandResult(
    "/auth",
    removed
      ? `Removed the local credential for ${id}. Provider-side OAuth grants are not revoked.`
      : `No local credential was stored for ${id}.`,
    removed ? "success" : "error",
  );
}

async function notifyModelSelectionChanged(services: ProviderServices): Promise<void> {
  const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
  services.onConfigChanged(config);
}

// --- /provider + /model ---

function modelHint(model: ModelEntry): string {
  const parts: string[] = [];
  const context = model.limit.context;
  if (context > 0) parts.push(`${Math.round(context / 1000)}k ctx`);
  if (model.reasoning) parts.push("reasoning");
  const input = model.cost?.input;
  const output = model.cost?.output;
  if (input !== undefined && output !== undefined) parts.push(`$${input}/$${output} per M`);
  return parts.join(" · ");
}

/**
 * The subscription ref that will actually serve a configured ref, or undefined
 * when the configured one stands. Keeps the precedence rule visible in status
 * output instead of only showing up in the ledger after a turn.
 */
async function servedBySubscription(
  resolved: { providerId: string; modelId: string },
  config: ClankieConfig,
  services: ProviderServices,
): Promise<string | undefined> {
  const ref = subscriptionRefFor(resolved, config);
  if (ref === undefined) return undefined;
  return (await services.store.get(CODEX_PROVIDER_ID)) === undefined ? undefined : ref;
}

async function showModelStatus(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const status = await modelStatus({ env: services.env, cwd: services.cwd });
  const ref = status.model;
  if (ref === null) {
    shell.insertCommandResult("/model status", "model: unset", "success");
    return;
  }
  const resolved = parseModelRef(ref);
  if (resolved === undefined) {
    shell.insertCommandResult("/model status", "model: unset", "success");
    return;
  }
  const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
  const served = await servedBySubscription(resolved, config, services);
  const variantId = status.effort;
  const variant = variantId === null ? "" : ` (${variantId})`;
  shell.insertCommandResult(
    "/model status",
    `model: ${formatModelRef(resolved)}${variant}${
      served === undefined ? "" : ` → ${served} (ChatGPT subscription)`
    }`,
    "success",
  );
}

async function showProviderStatus(
  shell: ClankieFaceShell,
  services: ProviderServices,
  selectedProvider: string | undefined,
): Promise<void> {
  const status = await modelStatus({ env: services.env, cwd: services.cwd });
  const listed = await services.store.list();
  const configured = status.model === null ? undefined : parseModelRef(status.model);
  const selected = selectedProvider ?? configured?.providerId;
  const pending =
    selected !== undefined && selected !== configured?.providerId
      ? ` (pending /model; configured ${configured?.providerId ?? "unset"})`
      : "";
  const kind = selected === undefined ? "" : ` · ${providerConnectionHint(selected, listed, services.env)}`;
  shell.insertCommandResult(
    "/provider status",
    `model: ${selected ?? "unset — run /provider"}${kind}${pending}`,
    "success",
  );
}

async function runProviderWizard(
  shell: ClankieFaceShell,
  services: ProviderServices,
  selectedProvider: string | undefined,
): Promise<string | undefined> {
  const flow = shell.setupFlow;
  flow.begin("choose provider for model");
  try {
    for (;;) {
      const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
      const listed = await services.store.list();
      const credentialIds = Object.keys(listed);
      const providers = await captainProviders(services, config, credentialIds);
      const configured = config.model === undefined ? undefined : parseModelRef(config.model);
      const currentProvider = selectedProvider ?? configured?.providerId;
      const picked = await flow.readSelect({
        message: `Provider for model (${providers.length} available — type to filter)`,
        options: providers.map((provider) => ({
          value: provider.id,
          label: provider.name,
          hint: providerConnectionHint(provider.id, listed, services.env),
        })),
        statusActions: [
          { value: "__refresh__", label: "refresh Pi model catalog" },
          { value: "__local__", label: "add a local endpoint…", hint: "Ollama, LM Studio, vLLM" },
        ],
        ...(currentProvider === undefined ? {} : { currentValue: currentProvider }),
        allowBack: true,
      });
      const providerId = picked;
      if (providerId === undefined) {
        flow.end();
        shell.insertCommandResult("/provider", "Provider selection cancelled.", "error");
        return selectedProvider;
      }
      if (providerId === "__local__") {
        const added = await addLocalProviderFlow(shell, services);
        if (added !== undefined) selectedProvider = added;
        continue;
      }
      if (providerId === "__refresh__") {
        flow.setStatus("refreshing Pi model catalog…");
        await services.captainModels.refresh();
        flow.renderLine("Pi model catalog refreshed.", "success");
        continue;
      }
      const provider = providers.find((candidate) => candidate.id === providerId);
      const hint = providerConnectionHint(providerId, listed, services.env);
      flow.end();
      shell.insertCommandResult(
        "/provider",
        [
          `Provider for model set to ${providerId} (${hint}). Run /model to choose the actual model.`,
          ...(provider !== undefined && !provider.connected
            ? [`Note: ${providerId} has no credential yet — run /auth before real Clankie turns.`]
            : []),
        ].join("\n"),
        "success",
      );
      return providerId;
    }
  } catch (error) {
    flow.end();
    throw error;
  }
}

// --- /provider → add a local endpoint ---

const LOCAL_PROVIDER_ID = "ollama";
const LOCAL_BASE_URL = "http://localhost:11434/v1";

function validateContextWindow(value: string): string | undefined {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a positive whole number of tokens.";
}

/**
 * Declares a local OpenAI-compatible endpoint in clankie.json (ADR 0012): a
 * `baseURL` is what routes a provider through the openai-compatible adapter,
 * and the endpoint's own model list stands in for the models.dev catalog.
 * Returns the provider id so the caller can preselect it.
 */
async function addLocalProviderFlow(
  shell: ClankieFaceShell,
  services: ProviderServices,
): Promise<string | undefined> {
  const flow = shell.setupFlow;
  const typedId = await flow.readText({
    message: "Provider id (becomes the providerId/modelId prefix)",
    defaultValue: LOCAL_PROVIDER_ID,
    validate: validateLocalProviderId,
    allowBack: true,
  });
  if (typedId === undefined) return undefined;
  const providerId = typedId.trim().toLowerCase();

  const typedUrl = await flow.readText({
    message: `Base URL for ${providerId} (OpenAI-compatible)`,
    defaultValue: LOCAL_BASE_URL,
    placeholder: LOCAL_BASE_URL,
    validate: validateLocalBaseUrl,
    allowBack: true,
  });
  if (typedUrl === undefined) return undefined;
  const baseURL = typedUrl.trim();

  flow.setStatus(`listing models at ${baseURL}…`);
  let models: readonly ProbedLocalModel[] = [];
  try {
    models = await probeLocalModels(baseURL, services.fetchImpl ?? fetch);
  } catch (error) {
    flow.renderLine(`Could not reach ${baseURL} (${String(error)}).`, "warning");
  }
  if (models.length === 0) {
    const typedModels = await flow.readText({
      message: "Model ids, comma-separated (the endpoint listed none)",
      placeholder: "qwen3:8b, gpt-oss:20b",
      validate: (value) =>
        value
          .split(",")
          .map((id) => id.trim())
          .some((id) => id.length > 0)
          ? undefined
          : "At least one model id is required.",
      allowBack: true,
    });
    if (typedModels === undefined) return undefined;
    models = typedModels
      .split(",")
      .map((id) => ({ id: id.trim() }))
      .filter((model) => model.id.length > 0);
  }
  if (models.length === 0) {
    shell.insertCommandResult("/provider", `No models given for ${providerId}; nothing written.`, "error");
    return undefined;
  }

  const typedContext = await flow.readText({
    message: "Context window in tokens (used for models the endpoint does not report)",
    defaultValue: String(
      models.find((model) => model.context !== undefined)?.context ?? LOCAL_CONTEXT_FALLBACK,
    ),
    validate: validateContextWindow,
    allowBack: true,
  });
  if (typedContext === undefined) return undefined;
  const fallbackContext = Number(typedContext.trim());

  const added = await modelDeclareLocal(
    {
      providerId,
      baseURL,
      models,
      fallbackContext,
    },
    { env: services.env, cwd: services.cwd },
  );
  const { config: updated } = await loadConfig({ env: services.env, cwd: services.cwd });
  services.onConfigChanged(updated);
  await services.captainModels.register(updated);
  flow.renderLine(`Added ${providerId} (${models.length} models).`, "success");
  shell.insertCommandResult(
    "/provider",
    [
      `${added.providerId} → ${added.baseURL} (${added.models.length} models) written to clankie.json.`,
      "No credential needed. Restart the service (`clankie restart captain`) before Clankie himself uses it.",
    ].join("\n"),
    "success",
  );
  return providerId;
}

async function runModelWizard(
  shell: ClankieFaceShell,
  services: ProviderServices,
  selectedProvider: string | undefined,
): Promise<string | undefined> {
  const flow = shell.setupFlow;
  flow.begin("choose model");
  try {
    for (;;) {
      const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
      const credentialIds = Object.keys(await services.store.list());
      const providers = await captainProviders(services, config, credentialIds);
      const configured = config.model === undefined ? undefined : parseModelRef(config.model);
      const providerId = selectedProvider ?? configured?.providerId;
      if (providerId === undefined) {
        flow.end();
        shell.insertCommandResult("/model", "No provider selected for model — run /provider first.", "error");
        return selectedProvider;
      }
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (provider === undefined) {
        flow.end();
        shell.insertCommandResult(
          "/model",
          `Provider ${providerId} is not currently enabled — run /provider to choose another.`,
          "error",
        );
        return undefined;
      }
      const models = await services.captainModels.models(providerId);
      if (models.length === 0) {
        flow.end();
        shell.insertCommandResult(
          "/model",
          `No models listed for ${providerId} — run /provider to choose another.`,
          "error",
        );
        return selectedProvider;
      }
      const currentRef = config.model;
      const currentParsed = currentRef === undefined ? undefined : parseModelRef(currentRef);
      const currentModelId = currentParsed?.providerId === providerId ? currentParsed.modelId : undefined;
      const pickedModel = await flow.readSelect({
        message: `Model from ${provider.name} (${models.length} listed, newest first — type to filter)`,
        options: models.map((model) => ({
          value: model.id,
          label: model.id,
          hint: modelHint(model),
          description: model.name,
        })),
        statusActions: [{ value: "__refresh__", label: "refresh Pi model catalog" }],
        ...(currentModelId === undefined ? {} : { currentValue: currentModelId }),
        allowBack: true,
      });
      const modelId = pickedModel;
      if (modelId === undefined) {
        flow.end();
        shell.insertCommandResult("/model", "Model selection cancelled.", "error");
        return selectedProvider;
      }
      if (modelId === "__refresh__") {
        flow.setStatus("refreshing Pi model catalog…");
        await services.captainModels.refresh();
        flow.renderLine("Pi model catalog refreshed.", "success");
        continue;
      }
      const ref = formatModelRef({ providerId, modelId });
      const served = await servedBySubscription({ providerId, modelId }, config, services);
      await modelSet(ref, { env: services.env, cwd: services.cwd });
      await notifyModelSelectionChanged(services);
      flow.end();
      shell.insertCommandResult(
        "/model",
        [
          `model set to ${ref}.`,
          ...(served === undefined
            ? []
            : [
                `Served by your ChatGPT subscription as ${served}; log out with /auth for metered API access.`,
              ]),
          ...(!provider.connected && served === undefined
            ? [`Note: ${providerId} has no credential yet — run /auth before real Clankie turns.`]
            : []),
        ].join("\n"),
        "success",
      );
      return undefined;
    }
  } catch (error) {
    flow.end();
    throw error;
  }
}

// --- /effort ---

async function runEffortWizard(shell: ClankieFaceShell, services: ProviderServices): Promise<void> {
  const { config } = await loadConfig({ env: services.env, cwd: services.cwd });
  const ref = config.model;
  if (ref === undefined) {
    shell.insertCommandResult(
      "/effort",
      "No Clankie model configured — run /provider, then /model first.",
      "error",
    );
    return;
  }
  const parsed = parseModelRef(ref);
  if (parsed === undefined) {
    shell.insertCommandResult(
      "/effort",
      "No Clankie model configured — run /provider, then /model first.",
      "error",
    );
    return;
  }
  const resolved = { ...parsed, variantId: config.variant?.[ref] };
  const levels = await services.captainModels.thinkingLevels(resolved.providerId, resolved.modelId);
  if (levels.length <= 1) {
    shell.insertCommandResult(
      "/effort",
      `${formatModelRef(resolved)} does not support configurable reasoning.`,
      "success",
    );
    return;
  }
  await chooseEffort(shell, services, resolved, levels);
}

async function chooseEffort(
  shell: ClankieFaceShell,
  services: ProviderServices,
  resolved: { providerId: string; modelId: string; variantId: string | undefined },
  levels: readonly string[],
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("reasoning effort");
  const ref = formatModelRef(resolved);
  const picked = await flow.readSelect({
    message: `Reasoning effort for ${ref}`,
    options: [
      ...levels.map((level) => ({ value: level, label: level })),
      { value: "__clear__", label: "default", hint: "Pi default: medium, clamped to this model" },
    ],
    ...(resolved.variantId === undefined ? {} : { currentValue: resolved.variantId }),
  });
  flow.end();
  const choice = picked;
  if (choice === undefined) {
    shell.insertCommandResult("/effort", "Effort selection cancelled.", "error");
    return;
  }
  await effortSet(choice === "__clear__" ? null : choice, ref, {
    env: services.env,
    cwd: services.cwd,
  });
  await notifyModelSelectionChanged(services);
  shell.insertCommandResult(
    "/effort",
    choice === "__clear__" ? `Effort override cleared for ${ref}.` : `Effort set to ${choice} for ${ref}.`,
    "success",
  );
}

async function captainProviders(
  services: ProviderServices,
  config: ClankieConfig,
  credentialIds: readonly string[],
): Promise<Array<{ id: string; name: string; connected: boolean }>> {
  const enabled = new Set(config.enabled_providers ?? []);
  const disabled = new Set(config.disabled_providers ?? []);
  return (await services.captainModels.providers())
    .filter((provider) => !disabled.has(provider.id) && (enabled.size === 0 || enabled.has(provider.id)))
    .map((provider) => ({
      ...provider,
      connected:
        credentialIds.includes(provider.id) ||
        providerEnvConnected(provider.id, services.env) ||
        config.provider?.[provider.id] !== undefined,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
