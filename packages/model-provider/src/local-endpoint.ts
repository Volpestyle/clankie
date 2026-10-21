import { parseModelRef, updateGlobalConfig, type ClankieConfig } from "./config.ts";

/**
 * Context window for a local model whose endpoint reports none. Clankie's first
 * request alone (system prompt plus tool schemas) measured 31,995 prompt tokens
 * on qwen3-vl:8b (VUH-2623), so a 32k guess left no room for the turn: Pi
 * compacted on almost every turn and clamped each reply to one output token.
 * Guessing high only costs an overflow error the runtime reports; guessing
 * below Clankie's own prompt cannot work.
 */
export const LOCAL_CONTEXT_FALLBACK = 131_072;
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
/**
 * Bearer sent to a locally declared endpoint that asks for none. A local
 * runtime (llama.cpp, vLLM, Ollama, LM Studio) ignores the value, but Pi
 * refuses to start a turn for a provider with no configured auth at all, so a
 * credential-less provider needs a placeholder to be usable. A real stored
 * credential for the same provider still wins over this.
 */
export const LOCAL_PLACEHOLDER_API_KEY = "local";

export interface ProbedLocalModel {
  readonly id: string;
  readonly context?: number;
}

export function localModelCatalogEntry(context: number): Record<string, unknown> {
  return { tool_call: true, limit: { context, output: Math.min(8_192, Math.floor(context / 4)) } };
}

export function validateLocalProviderId(value: string): string | undefined {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(value.trim().toLowerCase())
    ? undefined
    : "Use letters, digits, dot, dash, or underscore — no slashes.";
}

export function validateLocalBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a full URL, e.g. http://127.0.0.1:8000/v1";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "Only http:// and https:// endpoints work.";
  return undefined;
}

/** OpenAI-compatible local runtimes speak `/v1`; a bare origin is rewritten to `/v1`. */
export function normalizeLocalBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/u, "");
}

/**
 * Lists an OpenAI-compatible endpoint's models (`GET {baseURL}/models`).
 * Local runtimes are unknown to models.dev, so the endpoint itself is the catalog.
 */
export async function probeLocalModels(
  baseURL: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ProbedLocalModel[]> {
  const response = await fetchImpl(`${normalizeLocalBaseUrl(baseURL)}/models`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const body = (await response.json()) as { data?: unknown };
  const entries = Array.isArray(body.data) ? body.data : [];
  const listed: ProbedLocalModel[] = entries.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return [];
    const context = record.max_context_length ?? record.context_length;
    return [{ id: record.id, ...(typeof context === "number" && context > 0 ? { context } : {}) }];
  });
  return await Promise.all(
    listed.map(async (model) => {
      if (model.context !== undefined) return model;
      const context = await probeOllamaContext(baseURL, model.id, fetchImpl);
      return context === undefined ? model : { ...model, context };
    }),
  );
}

/**
 * Ollama's `/v1/models` reports no context length, so every model fell back to
 * the 32k default (VUH-2623). Its native `/api/show` reports the model's own
 * window as `model_info["<arch>.context_length"]`. Any other runtime answers
 * this route with an error, which leaves the model unreported.
 */
async function probeOllamaContext(
  baseURL: string,
  model: string,
  fetchImpl: typeof fetch,
): Promise<number | undefined> {
  try {
    const response = await fetchImpl(new URL("/api/show", normalizeLocalBaseUrl(baseURL)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { model_info?: unknown };
    if (typeof body.model_info !== "object" || body.model_info === null) return undefined;
    const context = Object.entries(body.model_info).find(([key]) => key.endsWith(".context_length"))?.[1];
    return typeof context === "number" && Number.isInteger(context) && context > 0 ? context : undefined;
  } catch {
    return undefined;
  }
}

export interface DeclareLocalProviderInput {
  readonly providerId: string;
  readonly baseURL: string;
  readonly models: readonly ProbedLocalModel[];
  readonly fallbackContext?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export function localProviderConfig(
  input: Omit<DeclareLocalProviderInput, "env">,
): NonNullable<ClankieConfig["provider"]>[string] {
  const providerId = input.providerId.trim().toLowerCase();
  const idError = validateLocalProviderId(providerId);
  if (idError !== undefined) throw new Error(idError);
  const baseURL = normalizeLocalBaseUrl(input.baseURL);
  const urlError = validateLocalBaseUrl(baseURL);
  if (urlError !== undefined) throw new Error(urlError);
  if (input.models.length === 0) throw new Error(`No models given for ${providerId}.`);
  const fallbackContext = input.fallbackContext ?? LOCAL_CONTEXT_FALLBACK;
  return {
    name: `${providerId} (local)`,
    npm: OPENAI_COMPATIBLE_NPM,
    options: { baseURL },
    models: Object.fromEntries(
      input.models.map((model) => [model.id, localModelCatalogEntry(model.context ?? fallbackContext)]),
    ),
  };
}

/** Writes a credential-less OpenAI-compatible local provider into global clankie.json. */
export async function declareLocalProvider(input: DeclareLocalProviderInput): Promise<ClankieConfig> {
  const providerId = input.providerId.trim().toLowerCase();
  const declared = localProviderConfig({ ...input, providerId });
  return await updateGlobalConfig(
    (current) => {
      current.provider = { ...current.provider, [providerId]: declared };
    },
    input.env === undefined ? {} : { env: input.env },
  );
}

export async function setCaptainModel(
  ref: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ClankieConfig> {
  const parsed = parseModelRef(ref);
  if (parsed === undefined)
    throw new Error(`Invalid model ref ${JSON.stringify(ref)}; expected providerId/modelId.`);
  return await updateGlobalConfig(
    (current) => void (current.model = `${parsed.providerId}/${parsed.modelId}`),
    options,
  );
}
