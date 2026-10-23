import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import type { TrustedOperatorIdentity } from "./app/types.ts";
import type { LoopbackPorts } from "./companion-app-identity.ts";

/** Socket provenance, scoped to the service's primary loopback listener. Headers confer no authority. */
export class LocalCompanionBoundary {
  private readonly admitted = new WeakSet<Request>();
  private readonly sameMac = new WeakSet<Request>();
  private readonly privateOwners = new WeakMap<Request, TrustedOperatorIdentity>();
  private readonly ports = new WeakMap<Request, LoopbackPorts>();
  /** The same-Mac socket's ports, so the redeeming process can be identified (VUH-2604). */
  loopbackPorts(request: Request): LoopbackPorts | undefined {
    return this.ports.get(request);
  }
  privateOwner(request: Request): TrustedOperatorIdentity | undefined {
    return this.privateOwners.get(request);
  }
  has(request: Request): boolean {
    return this.admitted.has(request);
  }

  /**
   * A native client on this Mac reaching the primary listener over loopback,
   * without the JSON body the companion routes demand. It only chooses which
   * addresses a device is told to use; it confers no authority.
   */
  isSameMac(request: Request): boolean {
    return this.sameMac.has(request);
  }

  /** Called only by the service-owned Unix listener in a same-UID private directory. */
  privateFetch(forward: (request: Request) => Response | Promise<Response>, owner?: TrustedOperatorIdentity) {
    return async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname !== "/v1/pairing/local/offer" || request.method !== "POST")
        return Response.json({ error: "not_found" }, { status: 404 });
      this.admitted.add(request);
      // The private directory/socket is the same-user authority. An explicitly
      // supplied bearer still goes through ordinary authentication, never fallback.
      if (owner && !request.headers.has("authorization")) this.privateOwners.set(request, owner);
      try {
        return await forward(request);
      } finally {
        this.admitted.delete(request);
        this.privateOwners.delete(request);
      }
    };
  }

  fetch(forward: (request: Request, env: HttpBindings | Http2Bindings) => Response | Promise<Response>) {
    return async (request: Request, env: HttpBindings | Http2Bindings): Promise<Response> => {
      const url = new URL(request.url);
      const remote = env.incoming.socket.remoteAddress;
      const local = env.incoming.socket.localAddress;
      const loopback = (address: string | undefined) =>
        address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
      const native = ![...request.headers.keys()].some(
        (header) =>
          header === "origin" ||
          header === "referer" ||
          header === "forwarded" ||
          (header.startsWith("sec-fetch-") && header !== "sec-fetch-mode") ||
          header.startsWith("x-forwarded-") ||
          header === "x-clankie-gateway",
      );
      // Node's native fetch adds only Sec-Fetch-Mode: cors. Browsers also add
      // Site/Dest (and Origin on JSON POSTs); those are always refused above.
      const mode = request.headers.get("sec-fetch-mode");
      const sameMac =
        (!mode || mode === "cors") &&
        loopback(remote) &&
        loopback(local) &&
        native &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        request.headers.get("host") === url.host;
      if (sameMac) this.sameMac.add(request);
      const client = env.incoming.socket.remotePort;
      const server = env.incoming.socket.localPort;
      if (sameMac && client !== undefined && server !== undefined)
        this.ports.set(request, { client, server });
      if (sameMac && request.headers.get("content-type")?.split(";")[0]?.trim() === "application/json") {
        this.admitted.add(request);
      }
      try {
        // The bindings carry the socket a WebSocket route upgrades (VUH-2727); never drop them.
        return await forward(request, env);
      } finally {
        this.admitted.delete(request);
        this.sameMac.delete(request);
        this.ports.delete(request);
      }
    };
  }
}
