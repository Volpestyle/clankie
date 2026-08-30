import type { Catalog } from "@clankie/model-registry";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { parseModelRef, type ClankieConfig } from "./config.ts";
import { providerFamilyFor } from "./instantiate.ts";
import { LOCAL_PLACEHOLDER_API_KEY } from "./local-endpoint.ts";
import { mergedCatalog, subscriptionRefFor } from "./resolve.ts";
import { thinkingLevelForVariant } from "./variants.ts";

export interface PiModelSelection {
  readonly model: Model<Api>;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly ref: string;
}

/** Resolves the captain ref and effort exactly as Pi will execute them. */
export function resolvePiModelSelection(
  config: ClankieConfig,
  runtime: Pick<ModelRuntime, "getModel">,
  hasCodexSubscription: boolean,
): PiModelSelection {
  const configuredRef = config.model;
  if (configuredRef === undefined) throw new Error("No captain model is configured; run /model");
  const configured = parseModelRef(configuredRef);
  if (configured === undefined) throw new Error("No captain model is configured; run /model");
  if (
    config.disabled_providers?.includes(configured.providerId) === true ||
    (config.enabled_providers !== undefined &&
      config.enabled_providers.length > 0 &&
      !config.enabled_providers.includes(configured.providerId))
  ) {
    throw new Error(`Configured captain provider ${configured.providerId} is disabled`);
  }
  const subscriptionRef = hasCodexSubscription ? subscriptionRefFor(configured, config) : undefined;
  const effective = parseModelRef(subscriptionRef ?? configuredRef);
  if (effective === undefined) throw new Error(`Invalid captain model ${configuredRef}`);
  const model = runtime.getModel(effective.providerId, effective.modelId);
  if (model === undefined) {
    throw new Error(
      `Configured captain model ${effective.providerId}/${effective.modelId} is not in pi's catalog`,
    );
  }
  const ref = `${effective.providerId}/${effective.modelId}`;
  const variant = config.variant?.[ref] ?? config.variant?.[configuredRef];
  return {
    model,
    ref,
    thinkingLevel: clampThinkingLevel(model, thinkingLevelForVariant(variant) ?? "medium"),
  };
}

/** Project Clankie's declarative custom providers into Pi's native provider registry. */
export function registerConfiguredPiProviders(
  runtime: ModelRuntime,
  config: ClankieConfig,
  catalog: Catalog,
): void {
  const merged = mergedCatalog(config, catalog);
  for (const [providerId, declared] of Object.entries(config.provider ?? {})) {
    const baseUrl = typeof declared.options?.baseURL === "string" ? declared.options.baseURL : undefined;
    const hasBuiltin = runtime.getProviders().some((provider) => provider.id === providerId);
    if (!hasBuiltin && baseUrl === undefined) continue;
    const models: ProviderConfig["models"] =
      declared.models === undefined
        ? undefined
        : Object.values(merged[providerId]?.models ?? {}).map((model) => ({
            id: model.id,
            name: model.name || model.id,
            reasoning: model.reasoning,
            input: (model.modalities?.input.includes("image") || model.attachment
              ? ["text", "image"]
              : ["text"]) as ("text" | "image")[],
            cost: {
              input: model.cost?.input ?? 0,
              output: model.cost?.output ?? 0,
              cacheRead: model.cost?.cache_read ?? 0,
              cacheWrite: model.cost?.cache_write ?? 0,
            },
            contextWindow: model.limit.context,
            maxTokens: model.limit.output,
          }));
    // A declared endpoint with no builtin and no env var naming its key is a
    // credential-less local runtime (ADR: `clankie model add-local`). Pi will
    // not start a turn for a provider it sees no auth for at all, so give it a
    // placeholder bearer the runtime ignores; a stored credential still wins.
    const placeholderAuth = !hasBuiltin && baseUrl !== undefined && (declared.env ?? []).length === 0;
    const provider: ProviderConfig = {
      ...(declared.name === undefined ? {} : { name: declared.name }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(!hasBuiltin ? { api: piApi(providerId, declared.npm, baseUrl) } : {}),
      ...(placeholderAuth ? { apiKey: LOCAL_PLACEHOLDER_API_KEY } : {}),
      ...(models === undefined ? {} : { models }),
    };
    runtime.registerProvider(providerId, provider);
  }
}

function piApi(providerId: string, npm: string | undefined, baseUrl: string | undefined): Api {
  const family = providerFamilyFor({ id: providerId, npm }, baseUrl);
  if (family === "anthropic") return "anthropic-messages";
  if (family === "google") return "google-generative-ai";
  if (family === "openai") return "openai-responses";
  return "openai-completions";
}
