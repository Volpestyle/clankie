import { PUBLIC_GATEWAY_ROUTES } from "@clankie/protocol/public-gateway";

// The direct device doorway (ADR 0204). The service listens on loopback only;
// a self-hosted phone on the LAN pairs and restores through this opt-in second
// listener, which opens onto exactly the device routes the public gateway
// carries to this Mac. Operator, webhook, gateway-envelope and hosted routes
// stay loopback-only, so exposing it never widens what a LAN peer can call
// beyond what the internet can already call through the gateway.

const DEVICE_ROUTE_PREFIXES = ["/v1/pairing/", "/v1/devices/", "/v1/model-keys", "/v1/accounts"];

const DEVICE_ROUTES = new Set(
  PUBLIC_GATEWAY_ROUTES.filter(
    (route) =>
      route.target === "control" && DEVICE_ROUTE_PREFIXES.some((prefix) => route.path.startsWith(prefix)),
  ).map((route) => `${route.method} ${route.path}`),
);

export const DEFAULT_DEVICE_DOORWAY_PORT = 4311;

/** Wrap the service's fetch so only device routes answer; everything else is a plain 404. */
export function deviceDoorwayFetch<Rest extends unknown[]>(
  fetch: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Response | Promise<Response> {
  return (request, ...rest) =>
    DEVICE_ROUTES.has(`${request.method} ${new URL(request.url).pathname}`)
      ? fetch(request, ...rest)
      : Response.json({ error: "not_found" }, { status: 404 });
}
