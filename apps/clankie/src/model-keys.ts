import type { BodyTelemetry, BodyModelTelemetryInput } from "@clankie/observability/body-telemetry";
import type { CredentialStore } from "@clankie/credential-broker";
import { createModelRegistry, loadBundledCatalog } from "@clankie/model-registry";
import {
  captainReadiness,
  CODEX_PROVIDER_ID,
  isHostedModelEnvironment,
  modelCredentialAllowed,
  loadConfig,
  parseModelRef,
  piModelFor,
  piModelsFor,
  registerConfiguredPiProviders,
  resolvePiModelSelection,
  setCaptainModel,
  thinkingLevelForVariant,
  updateGlobalConfig,
} from "@clankie/model-provider";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ModelEffort,
  ModelKeyResult,
  ModelKeysResponse,
  ModelOptionsResponse,
  ModelSubscriptionsResponse,
} from "@clankie/protocol/model-keys";
import { BrokerCredentialStore } from "./captain/model.ts";

export interface ModelKeysPort {
  readiness?(): Promise<import("@clankie/protocol/captain-readiness").CaptainReadinessResponse>;
  list(): Promise<ModelKeysResponse>;
  set(providerId: string, apiKey: string): Promise<ModelKeyResult>;
  validate(providerId: string, modelId: string): Promise<ModelKeyResult>;
  select(model: string): Promise<ModelKeyResult>;
  remove(providerId: string): Promise<ModelKeyResult>;
  /** Account sign-ins (OAuth/subscription) in use instead of an API key. */
  subscriptions?(): Promise<ModelSubscriptionsResponse>;
  /** Providers usable without key entry, and the running model's effort ladder. */
  options?(): Promise<ModelOptionsResponse>;
  /** The running model's effort; null returns it to the model's default. */
  setEffort?(effort: ModelEffort | null): Promise<ModelKeyResult>;
}

/** The CLI's config, broker, Pi runtime and models.dev fill, with a write-only wire projection. */
/**
 * The model library names a few providers for its own migrations; Clankie
 * shows the owner what they signed in to. Its "openai-codex" is the Codex
 * subscription Clankie runs on, not a legacy path.
 */
const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = { "openai-codex": "OpenAI Codex" };
export function providerDisplayName(provider: { readonly id: string; readonly name: string }): string {
  return PROVIDER_DISPLAY_NAMES[provider.id] ?? provider.name;
}

export function createModelKeys(options: {
  store: CredentialStore;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runtime?: () => Promise<ModelRuntime>;
  telemetry?: Pick<BodyTelemetry, "emit">;
  /**
   * Runs after a model is selected or a key removed. A hosted body re-decides
   * its model path there (VUH-1371): the customer's provider with their own
   * routing, or the included model with the plan's. Unset, nothing else moves.
   */
  onModelChanged?: () => Promise<void>;
}): ModelKeysPort {
  const { store } = options;
  const env = options.env ?? process.env;
  const telemetryCatalog = options.telemetry === undefined ? undefined : loadBundledCatalog();
  const report = (
    action: BodyModelTelemetryInput["action"],
    result: BodyModelTelemetryInput["result"],
    providerId: string,
    modelId?: string,
  ) => {
    const provider = telemetryCatalog?.[providerId];
    const knownProvider = provider?.id === providerId;
    const knownModel = knownProvider && modelId !== undefined && provider.models[modelId]?.id === modelId;
    try {
      options.telemetry?.emit({
        event: "body.model",
        action,
        result,
        ...(knownProvider ? { providerId: provider.id } : {}),
        ...(knownModel ? { modelId: provider.models[modelId]!.id } : {}),
      });
    } catch {
      /* Telemetry can never change a credential/config write outcome. */
    }
  };

  const registry = createModelRegistry({ env: options.env ?? process.env });
  let initialized: Promise<ModelRuntime> | undefined;
  const runtime = () =>
    (initialized ??=
      options.runtime?.() ??
      ModelRuntime.create({
        credentials: new BrokerCredentialStore(store, { env }),
        modelsPath: null,
        refreshOnCreate: false,
      }));
  const snapshot = async () => {
    const loaded = await loadConfig({
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    if (loaded.issues.length > 0) throw new Error("model_configuration_invalid");
    const catalog = await registry.catalog();
    const models = await runtime();
    registerConfiguredPiProviders(models, loaded.config, catalog);
    const { config } = loaded;
    const enabled = new Set(config.enabled_providers ?? []);
    const disabled = new Set(config.disabled_providers ?? []);
    const providers = models
      .getProviders()
      .filter((provider) => !disabled.has(provider.id) && (enabled.size === 0 || enabled.has(provider.id)));
    return { config, catalog, models, providers };
  };
  const apiProvider = async (providerId: string) => {
    const state = await snapshot();
    return state.providers.find((provider) => provider.id === providerId)?.auth.apiKey === undefined
      ? undefined
      : state;
  };
  /**
   * The model that runs, resolved without its stored effort so an effort the
   * model refuses can still be read and replaced here.
   */
  const running = async (state: Awaited<ReturnType<typeof snapshot>>) => {
    const credentials = await store.list();
    try {
      const { variant: _variant, ...config } = state.config;
      const selection = resolvePiModelSelection(config, state.models, {
        catalog: state.catalog,
        hasCodexSubscription: !isHostedModelEnvironment(env) && credentials[CODEX_PROVIDER_ID] !== undefined,
      });
      const providerId = parseModelRef(selection.ref)?.providerId;
      if (providerId === undefined || !modelCredentialAllowed(providerId, credentials[providerId], { env }))
        return undefined;
      return { ...selection, configuredRef: state.config.model ?? selection.ref, credentials };
    } catch {
      return undefined;
    }
  };
  return {
    async readiness() {
      const loaded = await loadConfig({ env, ...(options.cwd ? { cwd: options.cwd } : {}) });
      if (loaded.issues.length > 0) throw new Error("model_configuration_invalid");
      const report = captainReadiness({
        config: loaded.config,
        credentialIds: Object.keys(await store.list()),
        env,
      });
      return report.ready ? { ready: true, model: report.model, providerId: report.providerId } : report;
    },
    async list() {
      const state = await snapshot();
      const credentials = await store.list();
      let effectiveModel: string | null = null;
      try {
        effectiveModel = resolvePiModelSelection(state.config, state.models, {
          catalog: state.catalog,
          hasCodexSubscription:
            !isHostedModelEnvironment(env) && credentials[CODEX_PROVIDER_ID] !== undefined,
        }).ref;
        const effectiveProvider = parseModelRef(effectiveModel)?.providerId;
        if (
          effectiveProvider !== undefined &&
          !modelCredentialAllowed(effectiveProvider, credentials[effectiveProvider], { env })
        )
          effectiveModel = null;
      } catch {
        /* A new body has no model yet. */
      }
      return {
        model: state.config.model ?? null,
        effectiveModel,
        providers: state.providers
          .map((provider) => ({
            id: provider.id,
            name: providerDisplayName(provider),
            acceptsApiKey: provider.auth.apiKey !== undefined,
            keyConfigured: credentials[provider.id]?.type === "api",
            models: piModelsFor(state.models, provider.id, state).map(({ id, name }) => ({ id, name })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    async subscriptions() {
      const [state, credentials] = await Promise.all([snapshot(), store.list()]);
      return {
        subscriptions: state.providers
          .filter(
            (provider) =>
              credentials[provider.id]?.type === "oauth" &&
              modelCredentialAllowed(provider.id, credentials[provider.id], { env }),
          )
          .map((provider) => ({ providerId: provider.id, name: providerDisplayName(provider) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    async options() {
      const state = await snapshot();
      const selection = await running(state);
      const credentials = selection?.credentials ?? (await store.list());
      const available = new Set((await state.models.getAvailable()).map((model) => model.provider));
      const usableProviders = state.providers
        .filter(
          (provider) =>
            available.has(provider.id) &&
            modelCredentialAllowed(provider.id, credentials[provider.id], { env }),
        )
        .map((provider) => provider.id)
        .sort();
      if (selection === undefined) return { usableProviders, effort: null };
      const stored = state.config.variant?.[selection.ref] ?? state.config.variant?.[selection.configuredRef];
      const levels = getSupportedThinkingLevels(selection.model);
      const current = thinkingLevelForVariant(stored);
      return {
        usableProviders,
        effort: {
          model: selection.ref,
          current: current !== undefined && levels.includes(current) ? current : null,
          default: clampThinkingLevel(selection.model, "medium"),
          levels,
        },
      };
    },
    async setEffort(effort) {
      const selection = await running(await snapshot());
      if (selection === undefined) return { ok: false, error: "unsupported_model" };
      if (effort !== null && !getSupportedThinkingLevels(selection.model).includes(effort))
        return { ok: false, error: "unsupported_model" };
      // The runtime reads the served ref first, then the configured one; keep both
      // in step so `clankie effort` reports what runs.
      const refs = new Set([selection.ref, selection.configuredRef]);
      await updateGlobalConfig(
        (current) => {
          const variants = { ...current.variant };
          for (const ref of refs) {
            if (effort === null) delete variants[ref];
            else variants[ref] = effort;
          }
          current.variant = variants;
        },
        options.env === undefined ? {} : { env: options.env },
      );
      return { ok: true };
    },
    async set(providerId, apiKey) {
      let action: "key-set" | "key-replaced" = "key-set";
      try {
        if (
          !modelCredentialAllowed(providerId, { type: "api", key: apiKey }, { env }) ||
          (await apiProvider(providerId)) === undefined
        ) {
          report(action, "unsupported_provider", providerId);
          return { ok: false, error: "unsupported_provider" };
        }
        if (options.telemetry !== undefined) {
          try {
            if ((await store.list())[providerId]?.type === "api") action = "key-replaced";
          } catch {
            /* Optional replacement classification cannot prevent the write. */
          }
        }
        await store.set(providerId, { type: "api", key: apiKey });
        report(action, "ok", providerId);
        return { ok: true };
      } catch (error) {
        report(action, "unavailable", providerId);
        throw error;
      }
    },
    async validate(providerId, modelId) {
      const state = await apiProvider(providerId);
      if (state === undefined) return { ok: false, error: "unsupported_provider" };
      const model = piModelFor(state.models, providerId, modelId, state);
      if (model === undefined) return { ok: false, error: "unsupported_model" };
      const credential = await store.get(providerId);
      if (credential?.type !== "api") return { ok: false, error: "key_missing" };
      if (
        !modelCredentialAllowed(model.api === "anthropic-messages" ? "anthropic" : providerId, credential, {
          env,
        })
      )
        return { ok: false, error: "validation_failed" };
      const signal = AbortSignal.timeout(15_000);
      try {
        // No customer context, tools, conversation, or telemetry callbacks. Explicit auth
        // proves this stored key, never a subscription/env fallback. Discard all provider text.
        const response = await state.models.complete(
          model,
          {
            messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }],
          },
          {
            apiKey: credential.key,
            maxTokens: 16,
            maxRetries: 0,
            timeoutMs: 15_000,
            signal,
            transport: "sse",
            cacheRetention: "none",
          },
        );
        const result =
          response.stopReason === "error" || response.stopReason === "aborted"
            ? signal.aborted
              ? "validation_timeout"
              : "validation_failed"
            : "ok";
        report("key-validated", result, providerId);
        return result === "ok" ? { ok: true } : { ok: false, error: result };
      } catch {
        const result = signal.aborted ? "validation_timeout" : "validation_failed";
        report("key-validated", result, providerId);
        return { ok: false, error: result };
      }
    },
    async select(model) {
      const ref = parseModelRef(model);
      // Unknown input is never an identifier in telemetry: report() checks the bundled catalog.
      const providerId = ref?.providerId ?? "";
      try {
        const state = await snapshot();
        if (ref === undefined || !state.providers.some((provider) => provider.id === ref.providerId)) {
          report("model-selected", "unsupported_provider", providerId);
          return { ok: false, error: "unsupported_provider" };
        }
        if (!modelCredentialAllowed(providerId, await store.get(providerId), { env }))
          return { ok: false, error: "unsupported_model" };
        try {
          resolvePiModelSelection({ ...state.config, model }, state.models, {
            catalog: state.catalog,
            hasCodexSubscription:
              !isHostedModelEnvironment(env) && (await store.get(CODEX_PROVIDER_ID)) !== undefined,
          });
        } catch {
          report("model-selected", "unsupported_model", providerId, ref.modelId);
          return { ok: false, error: "unsupported_model" };
        }
        await setCaptainModel(model, options.env === undefined ? {} : { env: options.env });
        await options.onModelChanged?.();
        if (state.config.model !== model) report("model-selected", "ok", providerId, ref.modelId);
        return { ok: true };
      } catch (error) {
        report("model-selected", "unavailable", providerId, ref?.modelId);
        throw error;
      }
    },
    async remove(providerId) {
      try {
        if ((await apiProvider(providerId)) === undefined) {
          report("key-removed", "unsupported_provider", providerId);
          return { ok: false, error: "unsupported_provider" };
        }
        // This API manages API keys, never OAuth or internal service credentials.
        if ((await store.get(providerId))?.type === "api") {
          await store.delete(providerId);
          report("key-removed", "ok", providerId);
          await options.onModelChanged?.();
        }
        return { ok: true };
      } catch (error) {
        report("key-removed", "unavailable", providerId);
        throw error;
      }
    },
  };
}
