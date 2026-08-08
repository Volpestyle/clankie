import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AdoptWorkerRequestSchema,
  DirectAdoptedWorkerRequestSchema,
  ReleaseWorkerAdoptionRequestSchema,
  type AgentCensus,
} from "@clankie/protocol";

export const AGENT_CENSUS_GATEWAY_HOST = "127.0.0.1";
export const AGENT_CENSUS_GATEWAY_PORT = 4315;
const CENSUS_ROUTE = "/v1/agents/census";
const ADOPT_ROUTE = "/v1/agents/adopt";
const RELEASE_ROUTE = "/v1/agents/release";
const DIRECT_ROUTE = "/v1/agents/direct";
const MAX_BODY_BYTES = 64 * 1024;

export interface AgentCensusGateway {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
}

/**
 * The runner side of adoption (ADR 0078): an authenticated loopback plane the
 * control plane reads the census from, submits adoption decisions to, and
 * delivers bounded direction through. It carries no terminal bytes.
 *
 * Direction lives here rather than on the existing `/v1/workers/:id/steer` path
 * because that path is attempt-scoped — it claims a command against a live
 * worker run this runner started. An adopted agent has a `workerRunId` but no
 * attempt, so it has nothing to claim against; routing it through the same door
 * would mean inventing a fake attempt purely to satisfy the plumbing.
 */
export interface AgentCensusPort {
  census(): Promise<AgentCensus>;
  adopt(request: unknown): Promise<unknown>;
  release(request: unknown): Promise<void>;
  direct(request: unknown): Promise<unknown>;
}

export async function createAgentCensusGateway(options: {
  agents: AgentCensusPort;
  token: string;
  host?: string;
  port?: number;
}): Promise<AgentCensusGateway> {
  const host = options.host ?? AGENT_CENSUS_GATEWAY_HOST;
  const port = options.port ?? AGENT_CENSUS_GATEWAY_PORT;
  if (host !== AGENT_CENSUS_GATEWAY_HOST) {
    throw new Error("agent census gateway must bind exact loopback address 127.0.0.1");
  }
  if (!options.token || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("agent census gateway configuration is invalid");
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
  options: { agents: AgentCensusPort; token: string },
): Promise<void> {
  if (!authorized(request.headers.authorization, options.token)) {
    response.setHeader("www-authenticate", 'Bearer realm="clankie-agent-census"');
    return json(response, 401, { error: "authentication_required" });
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === CENSUS_ROUTE) {
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    return json(response, 200, { census: await options.agents.census() });
  }
  if (url.pathname === ADOPT_ROUTE) {
    if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
    const body = await readJsonBody(request);
    if (body === undefined) return json(response, 400, { error: "invalid_body" });
    const parsed = AdoptWorkerRequestSchema.safeParse(body);
    if (!parsed.success) return json(response, 400, { error: "invalid_request" });
    return json(response, 200, { result: await options.agents.adopt(parsed.data) });
  }
  if (url.pathname === DIRECT_ROUTE) {
    if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
    const body = await readJsonBody(request);
    if (body === undefined) return json(response, 400, { error: "invalid_body" });
    const parsed = DirectAdoptedWorkerRequestSchema.safeParse(body);
    if (!parsed.success) return json(response, 400, { error: "invalid_request" });
    return json(response, 200, { result: await options.agents.direct(parsed.data) });
  }
  if (url.pathname === RELEASE_ROUTE) {
    if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
    const body = await readJsonBody(request);
    if (body === undefined) return json(response, 400, { error: "invalid_body" });
    const parsed = ReleaseWorkerAdoptionRequestSchema.safeParse(body);
    if (!parsed.success) return json(response, 400, { error: "invalid_request" });
    await options.agents.release(parsed.data);
    return json(response, 200, { released: true });
  }
  return json(response, 404, { error: "not_found" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
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
