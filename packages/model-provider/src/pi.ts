import { listModels, type Catalog } from "@clankie/model-registry";
import type { Api } from "@earendil-works/pi-ai";
import type { ModelRuntime, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ClankieConfig } from "./config.ts";
import { providerFamilyFor } from "./instantiate.ts";
import { mergedCatalog } from "./resolve.ts";

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
        : listModels(merged, providerId).map((model) => ({
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
    const provider: ProviderConfig = {
      ...(declared.name === undefined ? {} : { name: declared.name }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(!hasBuiltin ? { api: piApi(providerId, declared.npm, baseUrl) } : {}),
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
