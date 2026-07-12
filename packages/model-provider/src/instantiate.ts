import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { ProviderCredential } from "@clankie/credential-broker";
import type { ProviderEntry } from "@clankie/model-registry";
import { wrapLanguageModel, type JSONValue, type LanguageModel } from "ai";
import type { ModelVariant } from "./variants.ts";

// ---------------------------------------------------------------------------
// Provider family — which AI SDK factory speaks a provider's protocol.
// ---------------------------------------------------------------------------

export type ProviderFamily = "anthropic" | "openai" | "google" | "xai" | "openai-compatible";

/**
 * Picks the AI SDK factory family for a provider. An explicit `baseURL` or an
 * `npm` of "@ai-sdk/openai-compatible" always routes through the generic
 * OpenAI-compatible factory (a custom endpoint is by convention OAI-shaped);
 * otherwise the provider id / npm package selects the native factory, and
 * anything unrecognized falls back to OpenAI-compatible.
 */
export function providerFamilyFor(
  provider: { id: string; npm?: string | undefined },
  baseURL?: string,
): ProviderFamily {
  if (provider.npm === "@ai-sdk/openai-compatible" || baseURL !== undefined) return "openai-compatible";
  if (provider.id === "anthropic" || provider.npm === "@ai-sdk/anthropic") return "anthropic";
  if (provider.id === "openai" || provider.id === "openai-codex" || provider.npm === "@ai-sdk/openai") {
    return "openai";
  }
  if (provider.id === "google" || provider.npm === "@ai-sdk/google") return "google";
  if (provider.id === "xai" || provider.npm === "@ai-sdk/xai") return "xai";
  return "openai-compatible";
}

// ---------------------------------------------------------------------------
// API key resolution — construction never throws. When nothing is configured
// we pass a placeholder key so the model constructs eagerly and the request
// fails at call time with the provider's own auth error.
// ---------------------------------------------------------------------------

/** Placeholder for OAuth credentials: the real bearer token is attached by the injected fetch wrapper (see oauth/). */
export const OAUTH_PLACEHOLDER_API_KEY = "clankie-oauth";
/** Placeholder when no credential or env var is available; the request fails at call time. */
export const UNCONFIGURED_PLACEHOLDER_API_KEY = "clankie-unconfigured";

function resolveApiKey(
  provider: ProviderEntry,
  credential: ProviderCredential | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (credential?.type === "api" || credential?.type === "wellknown") return credential.key;
  if (credential?.type === "oauth") return OAUTH_PLACEHOLDER_API_KEY;
  for (const name of provider.env) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return UNCONFIGURED_PLACEHOLDER_API_KEY;
}

// ---------------------------------------------------------------------------
// Instantiation
// ---------------------------------------------------------------------------

export interface CreateLanguageModelInput {
  provider: ProviderEntry & { id: string };
  modelId: string;
  credential?: ProviderCredential;
  /** Explicit endpoint override; routes instantiation through the OpenAI-compatible factory. */
  baseURL?: string;
  /** Injected fetch, e.g. the OAuth bearer wrapper or a test stub. */
  fetchImpl?: typeof fetch;
  /** Variant headers are baked into the provider; the body is applied at generate time via `variantProviderOptions`. */
  variant?: ModelVariant;
  /** Injected environment for API-key lookup; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Constructs an AI SDK language model for a provider/model pair. Never
 * throws for missing credentials — an unconfigured model fails at request
 * time instead, which keeps listing/selection flows total.
 */
export function createLanguageModel(input: CreateLanguageModelInput): LanguageModel {
  const apiKey = resolveApiKey(input.provider, input.credential, input.env ?? process.env);
  const family = providerFamilyFor(input.provider, input.baseURL);
  const fetchImpl = input.fetchImpl;
  const headers = input.variant?.headers;

  switch (family) {
    case "anthropic":
      return createAnthropic({
        apiKey,
        ...(fetchImpl !== undefined && { fetch: fetchImpl }),
        ...(headers !== undefined && { headers }),
      })(input.modelId);
    case "openai":
      return createOpenAI({
        apiKey,
        ...(fetchImpl !== undefined && { fetch: fetchImpl }),
        ...(headers !== undefined && { headers }),
      })(input.modelId);
    case "google":
      return createGoogleGenerativeAI({
        apiKey,
        ...(fetchImpl !== undefined && { fetch: fetchImpl }),
        ...(headers !== undefined && { headers }),
      })(input.modelId);
    case "xai":
      return createXai({
        apiKey,
        ...(fetchImpl !== undefined && { fetch: fetchImpl }),
        ...(headers !== undefined && { headers }),
      })(input.modelId);
    case "openai-compatible":
      return createOpenAICompatible({
        name: input.provider.id,
        // The catalog's `api` field is the provider's API base URL. The final
        // fallback keeps construction total; such a model fails at call time.
        baseURL: input.baseURL ?? input.provider.api ?? "http://unconfigured.invalid",
        apiKey,
        ...(fetchImpl !== undefined && { fetch: fetchImpl }),
        ...(headers !== undefined && { headers }),
      })(input.modelId);
  }
}

export interface CreateCodexLanguageModelInput {
  readonly modelId: string;
  readonly fetchImpl: typeof fetch;
  readonly instructions: string;
}

/**
 * Constructs the ChatGPT-subscription Responses model and makes the backend's
 * non-optional request contract impossible for callers to omit.
 */
export function createCodexLanguageModel(input: CreateCodexLanguageModelInput): LanguageModel {
  const provider = createOpenAI({ apiKey: OAUTH_PLACEHOLDER_API_KEY, fetch: input.fetchImpl });
  return wrapLanguageModel({
    model: provider.responses(input.modelId),
    middleware: {
      transformParams: async ({ params }) => {
        const providerOptions = params.providerOptions ?? {};
        const openai = { ...providerOptions.openai } as Record<string, JSONValue>;
        if (typeof openai.instructions !== "string" || openai.instructions.length === 0) {
          openai.instructions = input.instructions;
        }
        openai.store = false;
        return { ...params, providerOptions: { ...providerOptions, openai } };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Variant lowering — wire-format variant bodies become AI SDK providerOptions
// that the captain passes at generate time (bodies are per-call options and
// cannot be baked into a model instance).
// ---------------------------------------------------------------------------

export interface VariantCallOptions {
  providerOptions?: Record<string, Record<string, JSONValue>>;
  headers?: Record<string, string>;
}

/** providerOptions namespace each AI SDK package parses. */
const PROVIDER_OPTIONS_NAMESPACE: Record<ProviderFamily, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  xai: "xai",
  // @ai-sdk/openai-compatible@3 parses "openaiCompatible" for every provider
  // name ("openai-compatible" is accepted but deprecated).
  "openai-compatible": "openaiCompatible",
};

/**
 * Lowers a variant into `{ providerOptions, headers }` for `generateText` /
 * `streamText`. Wire-format snake_case body keys become the camelCase keys
 * the AI SDK option schemas expect (`reasoning_effort` → `reasoningEffort`,
 * `thinking.budget_tokens` → `thinking.budgetTokens`), namespaced under the
 * provider family's option key.
 */
export function variantProviderOptions(
  variant: ModelVariant | undefined,
  providerFamily: ProviderFamily,
): VariantCallOptions {
  if (variant === undefined) return {};
  const result: VariantCallOptions = {};
  if (variant.headers !== undefined && Object.keys(variant.headers).length > 0) {
    result.headers = { ...variant.headers };
  }
  if (variant.body !== undefined && Object.keys(variant.body).length > 0) {
    result.providerOptions = {
      [PROVIDER_OPTIONS_NAMESPACE[providerFamily]]: camelizeKeys(variant.body) as Record<string, JSONValue>,
    };
  }
  return result;
}

function camelizeKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [camelizeKey(key), camelizeKeys(entry)]),
  );
}
