import type { HttpBindings, Http2Bindings } from "@hono/node-server";

/** Socket provenance, scoped to the service's primary loopback listener. Headers confer no authority. */
export class LocalCompanionBoundary {
  private readonly admitted = new WeakSet<Request>();
  has(request: Request): boolean {
    return this.admitted.has(request);
  }

  /** Called only by the service-owned Unix listener in a same-UID private directory. */
  privateFetch(forward: (request: Request) => Response | Promise<Response>) {
    return async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname !== "/v1/pairing/local/offer" || request.method !== "POST")
        return Response.json({ error: "not_found" }, { status: 404 });
      this.admitted.add(request);
      try {
        return await forward(request);
      } finally {
        this.admitted.delete(request);
      }
    };
  }

  fetch(forward: (request: Request) => Response | Promise<Response>) {
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
      if (
        (!mode || mode === "cors") &&
        loopback(remote) &&
        loopback(local) &&
        native &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        request.headers.get("host") === url.host &&
        request.headers.get("content-type")?.split(";")[0]?.trim() === "application/json"
      ) {
        this.admitted.add(request);
      }
      try {
        return await forward(request);
      } finally {
        this.admitted.delete(request);
      }
    };
  }
}
