/**
 * The runner's one authenticated loopback plane
 * ([ADR 0087](../../../docs/adr/0087-one-loopback-plane.md)).
 *
 * Five capabilities used to mean five HTTP servers on five ports, each with its
 * own byte-identical `authorized`, `json`, and listen/close block. The server
 * was never the interesting part of any of them — the route table was — so the
 * server is written once here and each capability contributes only its routes.
 *
 * Capabilities register rather than being passed in at construction, because
 * they do not all exist at the same moment: transcripts and the census are
 * ready as soon as the runner can authenticate, while the browser and the shell
 * wait on doctrine. A capability that never registers is simply a 404, which is
 * the same thing an absent gateway used to be.
 */
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AdoptWorkerCommandSchema,
  CallBrowserToolRequestSchema,
  CAPTAIN_SHELL_READ_PATH,
  CAPTAIN_SHELL_RUN_PATH,
  CaptainFileReadRequestSchema,
  CaptainShellRunRequestSchema,
  DirectAdoptedWorkerCommandSchema,
  ReleaseWorkerAdoptionCommandSchema,
  WorkerTranscriptKeySchema,
  type WorkerTranscriptKey,
} from "@clankie/protocol";
import type { ActivityObservationProjection } from "./activity-observation.ts";
import type { AgentCensusPort } from "./agent-census.ts";
import type { BrowserHost } from "./browser-host.ts";
import type { CaptainShellHost } from "./captain-shell-host.ts";
import type { WorkerTranscriptProjection } from "./worker-transcript.ts";

export const LOOPBACK_GATEWAY_HOST = "127.0.0.1";
export const LOOPBACK_GATEWAY_PORT = 4313;
const MAX_BODY_BYTES = 64 * 1024;

export interface LoopbackContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  json(status: number, value: unknown): void;
  /** Parsed JSON body, or `undefined` when it is absent, malformed, or oversized. */
  readJson(): Promise<unknown>;
}

/** Returns `true` when it owned the request; `false` lets the next one try. */
export type LoopbackCapability = (context: LoopbackContext) => Promise<boolean> | boolean;

export interface LoopbackGateway {
  readonly address: { host: string; port: number };
  register(capability: LoopbackCapability): void;
  close(): Promise<void>;
}

export async function createLoopbackGateway(options: {
  token: string;
  bindHost?: string;
  port?: number;
}): Promise<LoopbackGateway> {
  const host = options.bindHost ?? LOOPBACK_GATEWAY_HOST;
  const port = options.port ?? LOOPBACK_GATEWAY_PORT;
  if (host !== LOOPBACK_GATEWAY_HOST) {
    throw new Error("runner loopback gateway must bind exact loopback address 127.0.0.1");
  }
  if (!options.token || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("runner loopback gateway configuration is invalid");
  }
  const capabilities: LoopbackCapability[] = [];
  const server = createServer((request, response) => {
    void dispatch(request, response, capabilities, options.token).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "internal_error" });
      else response.destroy();
    });
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
    register: (capability) => capabilities.push(capability),
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  capabilities: readonly LoopbackCapability[],
  token: string,
): Promise<void> {
  if (!authorized(request.headers.authorization, token)) {
    response.setHeader("www-authenticate", 'Bearer realm="clankie-runner"');
    return json(response, 401, { error: "authentication_required" });
  }
  const context: LoopbackContext = {
    request,
    response,
    url: new URL(request.url ?? "/", "http://127.0.0.1"),
    json: (status, value) => json(response, status, value),
    readJson: () => readJson(request),
  };
  for (const capability of capabilities) {
    if (await capability(context)) return;
  }
  return json(response, 404, { error: "not_found" });
}

// ---------------------------------------------------------------------------
// Capabilities. Each owns its paths and nothing else.
// ---------------------------------------------------------------------------

/** Bounded worker transcript reads, including the NDJSON tail (ADR 0037). */
export function workerTranscriptCapability(
  projection: WorkerTranscriptProjection,
): LoopbackCapability {
  return async ({ request, response, url, json: send }) => {
    const route = parseTranscriptRoute(url.pathname);
    if (!route) return false;
    if (request.method !== "GET") {
      send(405, { error: "method_not_allowed" });
      return true;
    }
    if (route.kind === "snapshot") {
      const outcome = projection.snapshot(route.key);
      send(outcome.outcome === "snapshot" ? 200 : outcome.outcome === "run_replaced" ? 409 : 404, outcome);
      return true;
    }
    const cursor = url.searchParams.get("cursor");
    if (!cursor || cursor.length > 2_048) {
      send(400, { error: "cursor_required" });
      return true;
    }
    const abort = new AbortController();
    request.once("close", () => abort.abort());
    const opened = projection.openTail(route.key, cursor, abort.signal);
    if (opened.outcome !== "tail") {
      send(opened.outcome === "not_found" ? 404 : 409, opened);
      return true;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.flushHeaders();
    for await (const line of opened.stream) {
      if (abort.signal.aborted || response.destroyed) return true;
      if (!response.write(`${JSON.stringify(line)}\n`)) await once(response, "drain");
    }
    response.end();
    return true;
  };
}

/**
 * The census and adoption decisions (ADR 0078).
 *
 * Direction lives here rather than on `/v1/workers/:id/steer` because that path
 * is attempt-scoped: it claims a command against a live worker run this runner
 * started. An adopted agent has a `workerRunId` but no attempt, so routing it
 * through the same door would mean inventing an attempt to satisfy plumbing.
 */
export function agentCensusCapability(agents: AgentCensusPort): LoopbackCapability {
  return async ({ request, url, json: send, readJson }) => {
    if (url.pathname === "/v1/agents/census") {
      if (request.method !== "GET") send(405, { error: "method_not_allowed" });
      else send(200, { census: await agents.census() });
      return true;
    }
    if (url.pathname === "/v1/agents/adopt") {
      await postRoute(request, send, readJson, AdoptWorkerCommandSchema, async (value) => ({
        result: await agents.adopt(value),
      }));
      return true;
    }
    if (url.pathname === "/v1/agents/direct") {
      await postRoute(request, send, readJson, DirectAdoptedWorkerCommandSchema, async (value) => ({
        result: await agents.direct(value),
      }));
      return true;
    }
    if (url.pathname === "/v1/agents/release") {
      await postRoute(request, send, readJson, ReleaseWorkerAdoptionCommandSchema, async (value) => {
        await agents.release(value);
        return { released: true };
      });
      return true;
    }
    return false;
  };
}

/** What Clankie is looking at right now (ADR 0077). Reads only; never frame bytes. */
export function activityObservationCapability(
  projection: ActivityObservationProjection,
): LoopbackCapability {
  return ({ request, url, json: send }) => {
    if (url.pathname !== "/v1/activity-observations/current") return false;
    if (request.method !== "GET") {
      send(405, { error: "method_not_allowed" });
      return true;
    }
    const snapshot = projection.current();
    if (snapshot === undefined) send(404, { error: "activity_observation_not_found" });
    else send(200, { snapshot });
    return true;
  };
}

/** Clankie's browser (ADR 0082). Descriptors are doctrine-projected before they leave. */
export function browserCapability(host: BrowserHost): LoopbackCapability {
  return async ({ request, url, json: send, readJson }) => {
    if (url.pathname === "/v1/browser/tools") {
      if (request.method !== "GET") send(405, { error: "method_not_allowed" });
      else send(200, { catalog: await host.catalog() });
      return true;
    }
    if (url.pathname === "/v1/browser/call") {
      await postRoute(request, send, readJson, CallBrowserToolRequestSchema, async (value) => ({
        result: await host.call(value),
      }));
      return true;
    }
    return false;
  };
}

/** Clankie's shell (ADR 0086). The sandbox and the doctrine decision stay on this side. */
export function captainShellCapability(host: CaptainShellHost): LoopbackCapability {
  return async ({ request, url, json: send, readJson }) => {
    if (url.pathname === CAPTAIN_SHELL_RUN_PATH) {
      await postRoute(request, send, readJson, CaptainShellRunRequestSchema, async (value) => ({
        result: await host.run(value),
      }));
      return true;
    }
    if (url.pathname === CAPTAIN_SHELL_READ_PATH) {
      await postRoute(request, send, readJson, CaptainFileReadRequestSchema, async (value) => ({
        result: await host.read(value),
      }));
      return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------

async function postRoute<T>(
  request: IncomingMessage,
  send: LoopbackContext["json"],
  readJson: LoopbackContext["readJson"],
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  run: (value: T) => Promise<unknown>,
): Promise<void> {
  if (request.method !== "POST") return send(405, { error: "method_not_allowed" });
  const body = await readJson();
  if (body === undefined) return send(400, { error: "invalid_body" });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return send(400, { error: "invalid_request" });
  send(200, await run(parsed.data));
}

function parseTranscriptRoute(
  pathname: string,
): { kind: "snapshot" | "tail"; key: WorkerTranscriptKey } | undefined {
  const fields = pathname
    .split("/")
    .filter(Boolean)
    .map((field) => decodeURIComponent(field));
  if (
    (fields.length !== 8 && fields.length !== 9) ||
    fields[0] !== "v1" ||
    fields[1] !== "missions" ||
    fields[3] !== "tasks" ||
    fields[5] !== "workers" ||
    fields[7] !== "transcript" ||
    (fields.length === 9 && fields[8] !== "tail")
  )
    return undefined;
  const key = WorkerTranscriptKeySchema.safeParse({
    missionId: fields[2],
    taskId: fields[4],
    workerRunId: fields[6],
  });
  return key.success ? { kind: fields.length === 9 ? "tail" : "snapshot", key: key.data } : undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
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
