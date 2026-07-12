import {
  createDefaultCredentialStore,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import {
  createModelRegistry,
  type Catalog,
  type ModelEntry,
  type ModelRegistry,
  type ProviderEntry,
} from "@clankie/model-registry";
import type { LanguageModel } from "ai";
import { loadConfig, type ClankieConfig } from "./config.ts";
import {
  createCodexLanguageModel,
  createLanguageModel,
  providerFamilyFor,
  variantProviderOptions,
  type VariantCallOptions,
} from "./instantiate.ts";
import { CODEX_PROVIDER_ID, createCodexFetch } from "./oauth/openai-codex.ts";
import { ANTHROPIC_PROVIDER_ID, createAnthropicFetch } from "./oauth/anthropic.ts";
import { mergedCatalog, resolveRole, type ModelRole } from "./resolve.ts";
import { effortVariantsFor, variantById, type ModelVariant } from "./variants.ts";

export const CAPTAIN_CODEX_PREAMBLE =
  "You are Clankie, a durable lead agent. Your complete persona, mission tools, and operating rules are supplied by Eve; follow them exactly.";

export class ConfiguredModelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfiguredModelError";
  }
}

export interface ConfiguredLanguageModel {
  readonly ref: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly model: LanguageModel;
  readonly modelContextWindowTokens?: number;
  readonly modelMaxOutputTokens?: number;
  readonly modelOptions?: VariantCallOptions;
}

export interface ResolveConfiguredLanguageModelOptions {
  readonly role?: ModelRole;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId?: string;
  readonly catalog?: Catalog;
  readonly registry?: ModelRegistry;
  readonly store?: CredentialStore;
  readonly fetchImpl?: typeof fetch;
}

function configuredBaseUrl(config: ClankieConfig, providerId: string): string | undefined {
  const value = config.provider?.[providerId]?.options?.baseURL;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasEnvironmentCredential(provider: ProviderEntry, env: NodeJS.ProcessEnv): boolean {
  return provider.env.some((name) => (env[name] ?? "").length > 0);
}

function selectedVariant(
  providerId: string,
  model: ModelEntry | undefined,
  variantId: string | undefined,
): ModelVariant | undefined {
  if (model === undefined || variantId === undefined) return undefined;
  const variant = variantById(effortVariantsFor(providerId, model), variantId);
  if (variant === undefined) {
    throw new ConfiguredModelError(
      `Model variant "${variantId}" is not supported by ${providerId}/${model.id}`,
    );
  }
  return variant;
}

/** Resolve the configured captain role into an opaque, ready-to-call model. */
export async function resolveConfiguredLanguageModel(
  options: ResolveConfiguredLanguageModelOptions = {},
): Promise<ConfiguredLanguageModel> {
  const role = options.role ?? "model";
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const store = options.store ?? createDefaultCredentialStore({ env });
  const registry = options.registry ?? createModelRegistry({ env });
  const [{ config, issues }, sourceCatalog] = await Promise.all([
    loadConfig({ cwd, env }),
    options.catalog === undefined ? registry.catalog() : Promise.resolve(options.catalog),
  ]);
  if (issues.length > 0) {
    throw new ConfiguredModelError(
      `Captain config is invalid: ${issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const resolved = resolveRole(role, { config, catalog: sourceCatalog });
  if (resolved === undefined)
    throw new ConfiguredModelError(`No ${role.replace("_", " ")} is configured; run /model`);
  const catalog = mergedCatalog(config, sourceCatalog);
  const provider = catalog[resolved.providerId];
  if (provider === undefined || resolved.model === undefined) {
    throw new ConfiguredModelError(
      `Configured model ${resolved.providerId}/${resolved.modelId} is not in the model registry`,
    );
  }
  const credential = await store.get(resolved.providerId);
  const baseURL = configuredBaseUrl(config, resolved.providerId);
  if (credential === undefined && baseURL === undefined && !hasEnvironmentCredential(provider, env)) {
    throw new ConfiguredModelError(`No credential is configured for ${resolved.providerId}; run /auth`);
  }
  const variant = selectedVariant(resolved.providerId, resolved.model, resolved.variantId);
  const family = providerFamilyFor(provider, baseURL);
  const modelOptions = variantProviderOptions(variant, family);
  const ref = `${resolved.providerId}/${resolved.modelId}`;
  const model =
    resolved.providerId === CODEX_PROVIDER_ID
      ? createCodexLanguageModel({
          modelId: resolved.modelId,
          fetchImpl: createCodexFetch({
            store,
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          }),
          instructions: CAPTAIN_CODEX_PREAMBLE,
        })
      : createLanguageModel({
          provider,
          modelId: resolved.modelId,
          ...(credential === undefined ? {} : { credential: credential as ProviderCredential }),
          ...(baseURL === undefined ? {} : { baseURL }),
          env,
          ...(resolved.providerId === ANTHROPIC_PROVIDER_ID && credential?.type === "oauth"
            ? {
                fetchImpl: createAnthropicFetch({
                  store,
                  ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
                }),
              }
            : options.fetchImpl === undefined
              ? {}
              : { fetchImpl: options.fetchImpl }),
          ...(variant === undefined ? {} : { variant }),
        });
  const context = resolved.model.limit.context;
  const maxOutput = resolved.model.limit.output;
  return {
    ref,
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    model,
    ...(context > 0 ? { modelContextWindowTokens: context } : {}),
    ...(maxOutput > 0 ? { modelMaxOutputTokens: maxOutput } : {}),
    ...(Object.keys(modelOptions).length > 0 ? { modelOptions } : {}),
  };
}
