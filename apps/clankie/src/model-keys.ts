import type { CredentialStore } from "@clankie/credential-broker";
import { createModelRegistry } from "@clankie/model-registry";
import {
  CODEX_PROVIDER_ID,
  loadConfig,
  parseModelRef,
  piModelFor,
  piModelsFor,
  registerConfiguredPiProviders,
  resolvePiModelSelection,
  setCaptainModel,
} from "@clankie/model-provider";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelKeyResult, ModelKeysResponse } from "@clankie/protocol/model-keys";
import { BrokerCredentialStore } from "./captain/model.ts";

export interface ModelKeysPort {
  list(): Promise<ModelKeysResponse>;
  set(providerId: string, apiKey: string): Promise<ModelKeyResult>;
  validate(providerId: string, modelId: string): Promise<ModelKeyResult>;
  select(model: string): Promise<ModelKeyResult>;
  remove(providerId: string): Promise<ModelKeyResult>;
}

/** The CLI's config, broker, Pi runtime and models.dev fill, with a write-only wire projection. */
export function createModelKeys(options: {
  store: CredentialStore;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runtime?: () => Promise<ModelRuntime>;
}): ModelKeysPort {
  const { store } = options;
  const registry = createModelRegistry({ env: options.env ?? process.env });
  let initialized: Promise<ModelRuntime> | undefined;
  const runtime = () =>
    (initialized ??=
      options.runtime?.() ??
      ModelRuntime.create({
        credentials: new BrokerCredentialStore(store),
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
  return {
    async list() {
      const state = await snapshot();
      const credentials = await store.list();
      let effectiveModel: string | null = null;
      try {
        effectiveModel = resolvePiModelSelection(state.config, state.models, {
          catalog: state.catalog,
          hasCodexSubscription: credentials[CODEX_PROVIDER_ID] !== undefined,
        }).ref;
      } catch {
        /* A new body has no model yet. */
      }
      return {
        model: state.config.model ?? null,
        effectiveModel,
        providers: state.providers
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            acceptsApiKey: provider.auth.apiKey !== undefined,
            keyConfigured: credentials[provider.id]?.type === "api",
            models: piModelsFor(state.models, provider.id, state).map(({ id, name }) => ({ id, name })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    async set(providerId, apiKey) {
      if ((await apiProvider(providerId)) === undefined) return { ok: false, error: "unsupported_provider" };
      await store.set(providerId, { type: "api", key: apiKey });
      return { ok: true };
    },
    async validate(providerId, modelId) {
      const state = await apiProvider(providerId);
      if (state === undefined) return { ok: false, error: "unsupported_provider" };
      const model = piModelFor(state.models, providerId, modelId, state);
      if (model === undefined) return { ok: false, error: "unsupported_model" };
      const credential = await store.get(providerId);
      if (credential?.type !== "api") return { ok: false, error: "key_missing" };
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
        return response.stopReason === "error" || response.stopReason === "aborted"
          ? { ok: false, error: signal.aborted ? "validation_timeout" : "validation_failed" }
          : { ok: true };
      } catch {
        return { ok: false, error: signal.aborted ? "validation_timeout" : "validation_failed" };
      }
    },
    async select(model) {
      const state = await snapshot();
      const ref = parseModelRef(model);
      if (ref === undefined || !state.providers.some((provider) => provider.id === ref.providerId))
        return { ok: false, error: "unsupported_provider" };
      try {
        resolvePiModelSelection({ ...state.config, model }, state.models, {
          catalog: state.catalog,
          hasCodexSubscription: (await store.get(CODEX_PROVIDER_ID)) !== undefined,
        });
      } catch {
        return { ok: false, error: "unsupported_model" };
      }
      await setCaptainModel(model, options.env === undefined ? {} : { env: options.env });
      return { ok: true };
    },
    async remove(providerId) {
      if ((await apiProvider(providerId)) === undefined) return { ok: false, error: "unsupported_provider" };
      // This API manages API keys, never OAuth or internal service credentials.
      if ((await store.get(providerId))?.type === "api") await store.delete(providerId);
      return { ok: true };
    },
  };
}
