import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ActivityObservationProjection } from "./activity-observation.ts";

export const ACTIVITY_OBSERVATION_GATEWAY_HOST = "127.0.0.1";
export const ACTIVITY_OBSERVATION_GATEWAY_PORT = 4314;
const CURRENT_ACTIVITY_ROUTE = "/v1/activity-observations/current";

export interface ActivityObservationGateway {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
}

/** Authenticated loopback read plane. It never accepts writes or frame bytes. */
export async function createActivityObservationGateway(options: {
  projection: ActivityObservationProjection;
  token: string;
  host?: string;
  port?: number;
}): Promise<ActivityObservationGateway> {
  const host = options.host ?? ACTIVITY_OBSERVATION_GATEWAY_HOST;
  const port = options.port ?? ACTIVITY_OBSERVATION_GATEWAY_PORT;
  if (host !== ACTIVITY_OBSERVATION_GATEWAY_HOST) {
    throw new Error("activity observation gateway must bind exact loopback address 127.0.0.1");
  }
  if (!options.token || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("activity observation gateway configuration is invalid");
  }
  const server = createServer((request, response) => {
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    if (!authorized(request.headers.authorization, options.token)) {
      response.setHeader("www-authenticate", 'Bearer realm="clankie-activity-observation"');
      return json(response, 401, { error: "authentication_required" });
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CURRENT_ACTIVITY_ROUTE) return json(response, 404, { error: "not_found" });
    const snapshot = options.projection.current();
    return snapshot === undefined
      ? json(response, 404, { error: "activity_observation_not_found" })
      : json(response, 200, { snapshot });
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
