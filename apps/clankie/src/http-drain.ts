import { Server as HttpServer } from "node:http";
import type { ServerType } from "@hono/node-server";

/**
 * Stop an HTTP server for shutdown without letting keep-alive clients pin
 * themselves to this process. `server.close()` only stops new connections: on
 * 2026-10-07 the operator seat's bridge kept polling the old service over one
 * keep-alive socket for 50 minutes after an update, so the replacement never
 * saw its seat bound.
 *
 * Every response from here on closes its connection, idle sockets close now,
 * and the returned function ends whatever is still open once shutdown settles.
 */
export function drainHttpServer(server: ServerType): () => void {
  if (!(server instanceof HttpServer)) {
    server.close();
    return () => undefined;
  }
  server.prependListener("request", (_request, response) => {
    response.shouldKeepAlive = false;
  });
  server.close();
  server.closeIdleConnections();
  return () => server.closeAllConnections();
}
