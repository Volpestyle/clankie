function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface OperatorRequestOptions {
  readonly controlPlaneUrl: string;
  readonly operatorToken?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

type ClosedStatus = "unavailable" | "unauthorized" | "interrupted";

/**
 * Fail-closed operator HTTP. Never surfaces a response body or token. Pairing
 * and devices share this fetch; each maps extra statuses (expired, not_found)
 * after the response returns.
 */
export async function operatorRequest(
  path: string,
  method: "GET" | "POST",
  options: OperatorRequestOptions,
  ErrorClass: new (status: ClosedStatus) => Error,
  extra?: { readonly jsonBody?: unknown; readonly contentType?: string },
): Promise<Response> {
  const token = options.operatorToken?.trim();
  if (token === undefined || token.length === 0) throw new ErrorClass("unauthorized");
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(path, options.controlPlaneUrl);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (extra?.contentType !== undefined) headers["content-type"] = extra.contentType;
  try {
    return await fetchImpl(url, {
      method,
      headers,
      ...(extra?.jsonBody === undefined ? {} : { body: JSON.stringify(extra.jsonBody) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted === true || isAbortError(error)) throw new ErrorClass("interrupted");
    throw new ErrorClass("unavailable");
  }
}
