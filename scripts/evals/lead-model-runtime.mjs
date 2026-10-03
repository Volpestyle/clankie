/** Dedicated fixed-model Pi runtime; raw registry and credentials never leave the controller. */
import { isDeepStrictEqual } from "node:util";
const sdk = await import(
  new URL("../../apps/clankie/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url)
    .href
);
const providerModule = await import(
  new URL(
    "../../apps/clankie/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js",
    import.meta.url,
  ).href
);
const api = await import(
  new URL(
    "../../apps/clankie/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
    import.meta.url,
  ).href
);

export async function createLeadModelRuntime({ modelId, selectedCredential, transport, admit }) {
  const catalog = providerModule.openaiCodexProvider();
  const found = catalog.getModels().find((model) => model.id === modelId);
  if (!found || !found.reasoning) throw Error("Pinned native Pi model unavailable");
  const model = structuredClone(found);
  model.baseUrl = "https://chatgpt.com/backend-api";
  model.headers = undefined;
  // Grammar/custom tools and dynamic catalogs are outside this bounded text/tool policy.
  model.compat = {
    ...model.compat,
    supportsOpenAIGrammarTools: false,
    supportsAdditionalTools: false,
    supportsToolSearch: false,
  };
  const credentials = Object.freeze({
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw Error("Lead credential mutation/refresh forbidden");
    },
    delete: async () => {
      throw Error("Lead credential deletion forbidden");
    },
  });
  const raw = await sdk.ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  // registerNativeProvider otherwise asynchronously refreshes every builtin's auth.
  // Override only this controller-owned instance before registration, never a prototype/package.
  Object.defineProperty(raw, "refresh", {
    value: async () => ({ aborted: false, errors: new Map() }),
    writable: false,
    configurable: false,
  });
  const auth = {
    apiKey: {
      name: "Protected selected native subscription",
      check: async () => ({ type: "api_key", source: "controller native observer" }),
      resolve: async () => ({
        auth: { apiKey: (await selectedCredential()).accessToken },
        source: "controller native observer",
      }),
    },
  };
  const fixed = (candidate, options = {}) => {
    if (!isDeepStrictEqual(candidate, model)) throw Error("Lead model/provider configuration mutated");
    for (const key of [
      "apiKey",
      "env",
      "fetch",
      "baseUrl",
      "serviceTier",
      "temperature",
      "toolChoice",
      "textVerbosity",
      "reasoningEffort",
    ])
      if (options[key] !== undefined) throw Error(`Lead provider option refused: ${key}`);
    if (options.headers !== undefined && !isDeepStrictEqual(options.headers, {}))
      throw Error("Lead provider option refused: headers");
    if (
      options.maxTokens === 1 ||
      (options.transport !== undefined && options.transport !== "sse") ||
      (options.maxRetries !== undefined && options.maxRetries !== 0) ||
      (options.reasoning !== undefined && options.reasoning !== "medium")
    )
      throw Error("Lead cache/retry/transport/reasoning policy refused");
    // SDK header/payload callbacks have no role with the inert loader. Never invoke or
    // forward caller callback hooks, alternate auth, caching, provider or transport.
    return {
      signal: options.signal,
      reasoning: "medium",
      reasoningEffort: "medium",
      reasoningSummary: "auto",
      textVerbosity: "low",
      transport: "sse",
      maxRetries: 0,
      cacheRetention: "none",
      fetch: transport.fetch,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      timeoutMs: 30_000,
    };
  };
  const guarded = {
    id: model.provider,
    name: "Fixed isolated lead Codex",
    auth,
    getModels: () => [structuredClone(model)],
    // Raw calls occur only after the facade has rejected overrides and prepareRequest
    // supplied this observer's selected token. The final injected fetch rechecks it.
    stream: (candidate, context, options) =>
      api.stream(model, context, {
        ...options,
        transport: "sse",
        maxRetries: 0,
        cacheRetention: "none",
        fetch: transport.fetch,
      }),
    streamSimple: (candidate, context, options) =>
      api.streamSimple(model, context, {
        ...options,
        reasoning: "medium",
        transport: "sse",
        maxRetries: 0,
        cacheRetention: "none",
        fetch: transport.fetch,
      }),
  };
  raw.registerNativeProvider(guarded);
  const stream = (method) => (candidate, context, options) => {
    const safe = fixed(candidate, options);
    return raw[method](model, structuredClone(context), safe);
  };
  const methods = {
    stream: stream("stream"),
    streamSimple: stream("streamSimple"),
    complete: (candidate, context, options) => methods.stream(candidate, context, options).result(),
    completeSimple: (candidate, context, options) =>
      methods.streamSimple(candidate, context, options).result(),
    getModel: (provider, id) =>
      provider === model.provider && id === model.id ? structuredClone(model) : undefined,
    getPhysicalModel: (provider, id) => methods.getModel(provider, id),
    getAvailableSnapshot: () => [structuredClone(model)],
    hasConfiguredAuth: (provider) => provider === model.provider,
    isUsingOAuth: () => false,
    isUsingSubscription: (provider) => provider === model.provider,
    checkAuth: async (provider) =>
      provider === model.provider ? { type: "api_key", source: "controller native observer" } : undefined,
    getAuth: async (candidate) => {
      if (!(candidate === model.provider || isDeepStrictEqual(candidate, model)))
        throw Error("Unselected lead provider");
      await admit();
      await selectedCredential();
      return { auth: { headers: {} }, source: "controller native observer" };
    },
    resolveModel: async (candidate) => {
      if (!isDeepStrictEqual(candidate, model)) throw Error("Unselected lead route");
      return { model: structuredClone(model), thinkingLevel: "medium" };
    },
  };
  const runtime = new Proxy(Object.freeze(methods), {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      throw Error("Lead runtime operation unavailable");
    },
  });
  const selection = () => ({
    model: structuredClone(model),
    ref: `${model.provider}/${model.id}`,
    thinkingLevel: "medium",
  });
  return Object.freeze({
    runtime,
    resolveSelection: async () => {
      await admit();
      return selection();
    },
    resolveRoute: async (purpose) => {
      await admit();
      return {
        route: { purpose, tier: "work", ref: `${model.provider}/${model.id}` },
        selection: selection(),
      };
    },
  });
}
