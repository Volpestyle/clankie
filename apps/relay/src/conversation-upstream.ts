import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceDispatch,
} from "../../../packages/protocol/src/index.ts";

export interface CaptainConversationDispatchOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Authenticated, schema-validating hop to the captain-owned registry service. */
export function createCaptainConversationDispatch(
  options: CaptainConversationDispatchOptions,
): OperatorConversationServiceDispatch {
  if (options.bearerToken.trim().length < 16) throw new Error("Captain bearer token is too short");
  const endpoint = new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, requireHttpBase(options.baseUrl));
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (request) => {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Captain conversation service returned HTTP ${response.status}`);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
}

function requireHttpBase(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Captain URL must use http or https");
  }
  return url;
}
