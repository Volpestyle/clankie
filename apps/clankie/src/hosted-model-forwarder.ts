import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HOSTED_MODEL_ENDPOINTS, type HostedBodyClient, type HostedModelEndpoint } from "./hosted-body.ts";
import {
  customerAuthHeaders,
  customerUpstreamUrl,
  isCustomerAuthHeader,
  type HostedCustomerModels,
} from "./hosted-customer-model.ts";

/** Where hired pi workers reach the customer's own model on this loopback (VUH-1373). */
export const CUSTOMER_LOOPBACK_PREFIX = "/customer";
/** A customer's provider takes larger requests than the fleet proxy; still bounded. */
const MAX_CUSTOMER_BODY_BYTES = 32 * 1024 * 1024;
/** Never forwarded either way: hop-by-hop, the caller's host and browser context, and lengths fetch recomputes. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "content-length",
  "origin",
  "referer",
  "cookie",
  "accept-encoding",
]);
const RELAYED_RESPONSE_DROPS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

/** The fleet model proxy refuses more; refusing here costs no signed request. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The proxy's answers that must reach the customer as they are and never be
 * retried: caps, plan refusals and replays (fleet README, "What the body's
 * forwarder must do"). `x-should-retry: false` keeps the OpenAI SDK's own
 * retry away from them; Pi's agent retry reads the `insufficient_quota` type
 * the caps carry and leaves them alone too.
 */
const NEVER_RETRY_STATUSES = new Set([400, 403, 409, 429]);

export interface HostedModelForwarder {
  /** `http://127.0.0.1:<port>/v1`, the base URL every model seam points at. */
  readonly baseURL: string;
  close(): Promise<void>;
}

export interface HostedModelForwarderLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

function endpointFor(request: IncomingMessage): HostedModelEndpoint | undefined {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  return HOSTED_MODEL_ENDPOINTS.find((endpoint) => path === `/v1/${endpoint}`);
}

function openAiError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.headersSent) return void response.destroy();
  response.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" });
  response.end(JSON.stringify({ error: { message, type: "invalid_request_error", code } }));
}

async function readBody(
  request: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > limit) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * The body's loopback model forwarder (VUH-1371). Every model seam that uses
 * the included model (`clankie/default`, `routine`, `escalation`) points here
 * with no key; each request is signed with the pairing key and sent, byte for
 * byte, to the fleet's model proxy, which holds the only provider key. The
 * answer comes back unchanged, status, content type and SSE stream alike.
 * Nothing but statuses and codes is logged.
 */
export async function startHostedModelForwarder(options: {
  readonly client: Pick<HostedBodyClient, "forwardModel">;
  /** The customer's own model, for hired pi workers in BYOK/BYOS mode (VUH-1373). */
  readonly customer?: Pick<HostedCustomerModels, "resolve">;
  readonly port?: number;
  readonly logger?: HostedModelForwarderLogger;
  readonly fetch?: typeof fetch;
}): Promise<HostedModelForwarder> {
  const upstreamFetch = options.fetch ?? fetch;
  /**
   * A hired pi worker's call to the customer's own model. The worker holds a
   * placeholder; the real credential comes from the broker on every call
   * (so a refreshed or replaced one is used at once) and is sent only to the
   * selected provider's base URL. Not an open proxy: no other destination, no
   * browser callers, POST only.
   */
  const handleCustomer = async (request: IncomingMessage, response: ServerResponse, pathAndQuery: string) => {
    if (request.method !== "POST") return openAiError(response, 404, "not_found", "Not a model endpoint.");
    if (request.headers.origin !== undefined) {
      return openAiError(
        response,
        403,
        "browser_refused",
        "The customer model loopback takes no browser requests.",
      );
    }
    const target = await options.customer?.resolve();
    if (target === undefined) {
      return openAiError(
        response,
        409,
        "no_customer_model",
        "No customer model and credential are selected.",
      );
    }
    const url = customerUpstreamUrl(target.baseUrl, pathAndQuery);
    if (url === undefined) return openAiError(response, 404, "not_found", "Not under the provider's API.");
    const body = await readBody(request, MAX_CUSTOMER_BODY_BYTES);
    if (body === undefined) {
      return openAiError(response, 413, "request_too_large", "The model request is larger than 32 MiB.");
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || isCustomerAuthHeader(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    for (const [name, value] of Object.entries(target.headers)) headers.set(name, value);
    for (const [name, value] of Object.entries(customerAuthHeaders(target.model.api, target.apiKey))) {
      headers.set(name, value);
    }
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) abort.abort();
    });
    let answer: Response;
    try {
      answer = await upstreamFetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: abort.signal,
      });
    } catch {
      options.logger?.warn(
        { event: "hosted.customer_model.unavailable" },
        "customer model provider unreachable",
      );
      return openAiError(response, 502, "provider_unreachable", "The model provider could not be reached.");
    }
    if (answer.status >= 400) {
      options.logger?.info(
        { event: "hosted.customer_model.refused", status: answer.status },
        "customer model refused",
      );
    }
    const relayed: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      if (!RELAYED_RESPONSE_DROPS.has(name)) relayed[name] = value;
    });
    response.writeHead(answer.status, relayed);
    if (answer.body === null) return void response.end();
    await pipeline(Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream), response).catch(
      () => {
        abort.abort();
      },
    );
  };
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      openAiError(response, 502, "forwarder_failed", "Clankie's model service could not be reached.");
    });
  });
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const pathAndQuery = request.url ?? "/";
    if (
      pathAndQuery === CUSTOMER_LOOPBACK_PREFIX ||
      pathAndQuery.startsWith(`${CUSTOMER_LOOPBACK_PREFIX}/`)
    ) {
      return handleCustomer(request, response, pathAndQuery.slice(CUSTOMER_LOOPBACK_PREFIX.length));
    }
    const endpoint = endpointFor(request);
    if (request.method !== "POST" || endpoint === undefined) {
      return openAiError(response, 404, "not_found", "Not a model endpoint.");
    }
    const body = await readBody(request);
    if (body === undefined) {
      return openAiError(response, 413, "request_too_large", "The model request is larger than 2 MiB.");
    }
    // The caller hanging up aborts the proxy call, which then costs only its reservation.
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) abort.abort();
    });
    let answer: Response;
    try {
      answer = await options.client.forwardModel(endpoint, body, abort.signal);
    } catch {
      options.logger?.warn({ event: "hosted.model.unavailable", endpoint }, "hosted model proxy unreachable");
      return openAiError(
        response,
        502,
        "model_proxy_unreachable",
        "Clankie's model service could not be reached.",
      );
    }
    const headers: Record<string, string> = {
      "content-type": answer.headers.get("content-type") ?? "application/json",
    };
    const resetsAt = answer.headers.get("x-clankie-allowance-resets-at");
    if (resetsAt !== null) headers["x-clankie-allowance-resets-at"] = resetsAt;
    if (NEVER_RETRY_STATUSES.has(answer.status)) headers["x-should-retry"] = "false";
    if (answer.status >= 400) {
      options.logger?.info(
        { event: "hosted.model.refused", endpoint, status: answer.status },
        "model call refused",
      );
    }
    response.writeHead(answer.status, headers);
    if (answer.body === null) return void response.end();
    await pipeline(Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream), response).catch(
      () => {
        abort.abort();
      },
    );
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
