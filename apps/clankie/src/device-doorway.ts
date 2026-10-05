import { publicGatewayTargetFor, type PublicGatewayRoute } from "@clankie/protocol/public-gateway";

// The direct device doorway (ADR 0204). The service listens on loopback only;
// a self-hosted phone on the LAN pairs and restores through this opt-in second
// listener, which opens onto exactly the device routes the public gateway
// carries to this Mac. Operator, webhook, gateway-envelope and hosted routes
// stay loopback-only, so exposing it never widens what a LAN peer can call
// beyond what the internet can already call through the gateway.

const DEVICE_ROUTE_PREFIXES = [
  "/v1/devices",
  "/v1/pairing/",
  "/v1/model-keys",
  "/v1/accounts",
  "/v1/captain/readiness",
  "/v1/support/grants",
];

export const DEFAULT_DEVICE_DOORWAY_PORT = 4311;

/** Wrap the service's fetch so only device routes answer; everything else is a plain 404. */
export function deviceDoorwayFetch<Rest extends unknown[]>(
  fetch: (request: Request, ...rest: Rest) => Response | Promise<Response>,
  gatewayRoutes: readonly PublicGatewayRoute[] = [],
): (request: Request, ...rest: Rest) => Response | Promise<Response> {
  return (request, ...rest) => {
    const path = new URL(request.url).pathname;
    const method = request.method;
    const allowed =
      (method === "GET" || method === "POST") &&
      DEVICE_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
      publicGatewayTargetFor(method, path, gatewayRoutes) === "control";
    return allowed ? fetch(request, ...rest) : Response.json({ error: "not_found" }, { status: 404 });
  };
}
