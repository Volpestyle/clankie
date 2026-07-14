import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { WorkerTranscriptKeySchema, type WorkerTranscriptKey } from "@clankie/protocol";
import type { WorkerTranscriptProjection } from "./worker-transcript.ts";

export const WORKER_TRANSCRIPT_GATEWAY_HOST = "127.0.0.1";
export const WORKER_TRANSCRIPT_GATEWAY_PORT = 4313;

export interface WorkerTranscriptGateway {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
}

export async function createWorkerTranscriptGateway(options: {
  projection: WorkerTranscriptProjection;
  token: string;
  host?: string;
  port?: number;
}): Promise<WorkerTranscriptGateway> {
  const host = options.host ?? WORKER_TRANSCRIPT_GATEWAY_HOST;
  const port = options.port ?? WORKER_TRANSCRIPT_GATEWAY_PORT;
  if (host !== WORKER_TRANSCRIPT_GATEWAY_HOST) {
    throw new Error("worker transcript gateway must bind exact loopback address 127.0.0.1");
  }
  if (!options.token || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("worker transcript gateway configuration is invalid");
  }
  const server = createServer((request, response) => {
    void handle(request, response, options.projection, options.token).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "transcript_gateway_failure" });
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
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  projection: WorkerTranscriptProjection,
  token: string,
): Promise<void> {
  if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
  if (!authorized(request.headers.authorization, token)) {
    response.setHeader("www-authenticate", 'Bearer realm="clankie-worker-transcript"');
    return json(response, 401, { error: "authentication_required" });
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = parseRoute(url.pathname);
  if (!route) return json(response, 404, { error: "not_found" });
  if (route.kind === "snapshot") {
    const outcome = projection.snapshot(route.key);
    return json(
      response,
      outcome.outcome === "snapshot" ? 200 : outcome.outcome === "run_replaced" ? 409 : 404,
      outcome,
    );
  }
  const cursor = url.searchParams.get("cursor");
  if (!cursor || cursor.length > 2_048) return json(response, 400, { error: "cursor_required" });
  const abort = new AbortController();
  request.once("close", () => abort.abort());
  const opened = projection.openTail(route.key, cursor, abort.signal);
  if (opened.outcome !== "tail") {
    return json(response, opened.outcome === "not_found" ? 404 : 409, opened);
  }
  response.statusCode = 200;
  response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.flushHeaders();
  for await (const line of opened.stream) {
    if (abort.signal.aborted || response.destroyed) return;
    if (!response.write(`${JSON.stringify(line)}\n`)) await once(response, "drain");
  }
  response.end();
}

function parseRoute(pathname: string): { kind: "snapshot" | "tail"; key: WorkerTranscriptKey } | undefined {
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
