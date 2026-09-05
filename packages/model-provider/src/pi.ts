import type { Catalog, ModelEntry } from "@clankie/model-registry";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { ModelRuntime, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { parseModelRef, type ClankieConfig } from "./config.ts";
import { providerFamilyFor } from "./instantiate.ts";
import { LOCAL_PLACEHOLDER_API_KEY } from "./local-endpoint.ts";
import { mergedCatalog, subscriptionRefFor } from "./resolve.ts";
import { effortVariantsFor, thinkingLevelForVariant } from "./variants.ts";

export interface PiModelSelection {
  readonly model: Model<Api>;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly ref: string;
}

/** Resolves the captain ref and effort exactly as Pi will execute them. */
export function resolvePiModelSelection(
  config: ClankieConfig,
  runtime: Pick<ModelRuntime, "getModel" | "getModels">,
  input: {
    readonly hasCodexSubscription: boolean;
    /** Clankie's own catalog, consulted for models Pi's catalog has not learned yet. */
    readonly catalog: Catalog;
  },
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
  const subscriptionRef = input.hasCodexSubscription ? subscriptionRefFor(configured, config) : undefined;
  const effective = parseModelRef(subscriptionRef ?? configuredRef);
  if (effective === undefined) throw new Error(`Invalid captain model ${configuredRef}`);
  const model = piModelFor(runtime, effective.providerId, effective.modelId, {
    config,
    catalog: input.catalog,
  });
  if (model === undefined) {
    throw new Error(
      `Configured captain model ${effective.providerId}/${effective.modelId} has no supported Pi model entry. ` +
        `For a newly released OpenAI model, run \`clankie model refresh\`.`,
    );
  }
  const ref = `${effective.providerId}/${effective.modelId}`;
  const variant = config.variant?.[ref] ?? config.variant?.[configuredRef];
  return { model, ref, thinkingLevel: resolveThinkingLevel(model, ref, variant) };
}

/**
 * The effort Pi will actually send, or an error naming what the model takes.
 *
 * `clampThinkingLevel` answers every request with *some* level, which is the
 * right default when nobody asked — but for a configured effort it turns
 * "Astra has no `none`" or a typo into a quiet downgrade the receipt still
 * reports as the selection. The AI SDK adapter already refuses an unsupported
 * variant outright (`selectedVariant` in configured-model.ts); this is the same
 * answer on the Pi side, so both adapters fail the same way.
 */
function resolveThinkingLevel(
  model: Model<Api>,
  ref: string,
  variant: string | undefined,
): ModelThinkingLevel {
  if (variant === undefined) return clampThinkingLevel(model, "medium");
  const level = thinkingLevelForVariant(variant);
  const supported = getSupportedThinkingLevels(model);
  if (level === undefined || !supported.includes(level)) {
    throw new Error(
      `Effort "${variant}" is not supported by ${ref}; it accepts ${supported.join(", ")}. ` +
        `Run \`clankie effort set <level> --model ${ref}\`.`,
    );
  }
  return level;
}

/**
 * One provider's models as selection should see them: Pi's own catalog, plus
 * the entries only Clankie's catalog knows.
 *
 * Clankie runs two model adapters over one selection — the captain streams
 * through Pi's catalog, gameplay and commentary through the AI SDK over
 * models.dev — and Pi's catalog ships with the package and lags. `gpt-6-astra`
 * is absent from pi-ai 0.84.2 and stays absent after a forced pi.dev refresh,
 * so without this fill the captain refuses a ref every other path accepts and a
 * probe-verified subscription model is unreachable until pi cuts a release.
 * Pi's own entry always wins where both know a model: its metadata is
 * transport-specific.
 */
export function piModelsFor(
  runtime: Pick<ModelRuntime, "getModels">,
  providerId: string,
  input: { readonly config: ClankieConfig; readonly catalog: Catalog },
): readonly Model<Api>[] {
  const known = runtime.getModels(providerId);
  const seen = new Set(known.map((model) => model.id));
  const models = mergedCatalog(input.config, input.catalog)[providerId]?.models ?? {};
  const filled = Object.values(models)
    .filter((entry) => !seen.has(entry.id))
    .map((entry) => piModelFromCatalog(known, models, entry))
    .filter((model): model is Model<Api> => model !== undefined);
  return [...known, ...filled];
}

/** {@link piModelsFor} for one id: Pi's entry, else the catalog fill. */
export function piModelFor(
  runtime: Pick<ModelRuntime, "getModel" | "getModels">,
  providerId: string,
  modelId: string,
  input: { readonly config: ClankieConfig; readonly catalog: Catalog },
): Model<Api> | undefined {
  const known = runtime.getModel(providerId, modelId);
  if (known !== undefined) return known;
  const models = mergedCatalog(input.config, input.catalog)[providerId]?.models ?? {};
  return piModelFromCatalog(runtime.getModels(providerId), models, models[modelId]);
}

/**
 * The filled entry rides a sibling model's `api`/`baseUrl`/`compat`, which is
 * what makes this a fill rather than a second transport: an id the provider
 * cannot actually serve is still refused by the backend, with the backend's own
 * reason. A provider Pi knows nothing about has no sibling to ride and stays
 * unresolvable.
 */
function piModelFromCatalog(
  siblings: readonly Model<Api>[],
  models: Readonly<Record<string, ModelEntry>>,
  entry: ModelEntry | undefined,
): Model<Api> | undefined {
  if (entry === undefined || entry.id === "") return undefined;
  const sibling = transportSibling(siblings, models);
  if (sibling === undefined) return undefined;
  // Only these providers have a verified common transport. Aggregators such
  // as opencode mix wire protocols and URLs; models.dev cannot identify which
  // one an unknown model needs, so their membership remains Pi's decision.
  if (sibling.provider !== "openai" && sibling.provider !== "openai-codex") return undefined;
  return {
    ...sibling,
    id: entry.id,
    name: entry.name || entry.id,
    reasoning: entry.reasoning,
    thinkingLevelMap: piThinkingLevelMap(sibling.provider, entry),
    input:
      entry.modalities?.input.includes("image") === true || entry.attachment ? ["text", "image"] : ["text"],
    cost: {
      input: entry.cost?.input ?? 0,
      output: entry.cost?.output ?? 0,
      cacheRead: entry.cost?.cache_read ?? 0,
      cacheWrite: entry.cost?.cache_write ?? 0,
    },
    contextWindow: entry.limit.context,
    maxTokens: entry.limit.output,
  };
}

/**
 * Which sibling's transport the fill rides.
 *
 * `api` and `baseUrl` are uniform across the supported OpenAI providers, but
 * `compat` is not — and Pi's bundled data files are ordered oldest-first, so taking the
 * first sibling hands a brand-new model the least capable generation's
 * capability flags. On `openai-codex` that is `gpt-5.3-codex-spark`, alone in
 * the provider in lacking `supportsAdditionalTools` and `supportsToolSearch`;
 * on `openai` it is `gpt-4`. Nothing corrects that downstream: the codex
 * transport reads every flag as `?? false`.
 *
 * So ride the newest sibling the catalog dates. A model Pi has not learned yet
 * is by construction newer than everything Pi ships, and these flags track
 * model generation. The order comes from models.dev release dates rather than
 * from counting compat keys, which would read a deliberate `false` as a missing
 * capability; undated siblings fall back to catalog order, where last is newest.
 */
function transportSibling(
  siblings: readonly Model<Api>[],
  models: Readonly<Record<string, ModelEntry>>,
): Model<Api> | undefined {
  let newest: Model<Api> | undefined;
  let newestRelease = "";
  for (const sibling of siblings) {
    const released = models[sibling.id]?.release_date ?? "";
    if (newest === undefined || released >= newestRelease) {
      newest = sibling;
      newestRelease = released;
    }
  }
  return newest;
}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Restates Clankie's effort ladder for the model in Pi's vocabulary, so
 * `/effort` and the captain offer exactly what the AI SDK path offers.
 *
 * A level the ladder does not carry is marked unsupported rather than left to
 * Pi's defaults: Astra has no `none` and no `minimal`, and Pi would otherwise
 * offer both and quietly answer a request for them at some other tier. A
 * supported level keeps its key omitted so Pi's own wire mapping applies —
 * that is what turns `off` into the provider's `none` and what keeps a
 * budget-shaped provider's levels in the provider's hands. `xhigh` and `max`
 * are the exception Pi's own rule forces: it offers them only when the map
 * names them.
 */
function piThinkingLevelMap(providerId: string, entry: ModelEntry): ThinkingLevelMap {
  const levels = new Set(
    effortVariantsFor(providerId, entry).map((variant) => thinkingLevelForVariant(variant.id)),
  );
  return {
    ...Object.fromEntries(
      PI_THINKING_LEVELS.filter((level) => !levels.has(level)).map((level) => [level, null]),
    ),
    ...(levels.has("xhigh") ? { xhigh: "xhigh" } : {}),
    ...(levels.has("max") ? { max: "max" } : {}),
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
