/**
 * The runner side of Clankie's browser
 * ([ADR 0082](../../../docs/adr/0082-clankie-holds-the-browser.md)): an
 * authenticated loopback plane the control plane reads the projected tool
 * catalog from and submits calls to.
 *
 * It carries no profile bytes, no cookies, and no socket handle — only
 * doctrine-projected descriptors and bounded text results. The browser itself
 * stays a runner-owned process, so a compromised control plane can ask for a
 * page but cannot take the browser.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CallBrowserToolRequestSchema } from "@clankie/protocol";
import type { BrowserHost } from "./browser-host.ts";

export const BROWSER_GATEWAY_HOST = "127.0.0.1";
export const BROWSER_GATEWAY_PORT = 4316;
const CATALOG_ROUTE = "/v1/browser/tools";
const CALL_ROUTE = "/v1/browser/call";
const MAX_BODY_BYTES = 64 * 1024;

export interface BrowserGateway {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
}

export async function createBrowserGateway(options: {
  host: BrowserHost;
  token: string;
  bindHost?: string;
  port?: number;
}): Promise<BrowserGateway> {
  const host = options.bindHost ?? BROWSER_GATEWAY_HOST;
  const port = options.port ?? BROWSER_GATEWAY_PORT;
  if (host !== BROWSER_GATEWAY_HOST) {
    throw new Error("browser gateway must bind exact loopback address 127.0.0.1");
  }
  if (!options.token || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("browser gateway configuration is invalid");
  }
  const server = createServer((request, response) => {
    void handle(request, response, options).catch(() => json(response, 500, { error: "internal_error" }));
  });
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolvePromise();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    address: { host, port: boundPort },
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: { host: BrowserHost; token: string },
): Promise<void> {
  if (!authorized(request.headers.authorization, options.token)) {
    response.setHeader("www-authenticate", 'Bearer realm="clankie-browser"');
    return json(response, 401, { error: "authentication_required" });
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === CATALOG_ROUTE) {
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    return json(response, 200, { catalog: await options.host.catalog() });
  }
  if (url.pathname === CALL_ROUTE) {
    if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      return json(response, 400, { error: "invalid_request" });
    }
    const parsed = CallBrowserToolRequestSchema.safeParse(body);
    if (!parsed.success) return json(response, 400, { error: "invalid_request" });
    return json(response, 200, { result: await options.host.call(parsed.data) });
  }
  return json(response, 404, { error: "not_found" });
}

async function readBody(request: IncomingMessage): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}
