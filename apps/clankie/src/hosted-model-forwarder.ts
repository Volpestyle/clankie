import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HOSTED_MODEL_ENDPOINTS, type HostedBodyClient, type HostedModelEndpoint } from "./hosted-body.ts";

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

async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) return undefined;
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
  readonly port?: number;
  readonly logger?: HostedModelForwarderLogger;
}): Promise<HostedModelForwarder> {
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      openAiError(response, 502, "forwarder_failed", "Clankie's model service could not be reached.");
    });
  });
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
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
