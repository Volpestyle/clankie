/**
 * Which client a request came from, for per-client budgets. Behind Caddy every
 * socket peer is Caddy, so the peer address alone puts every client in one
 * bucket. Caddy (2.5 and later) replaces any client-sent X-Forwarded-For with
 * the address it saw, so its last entry is the client, but only when the
 * socket peer really is Caddy. From any other peer the header is the caller's
 * own claim and is ignored.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export interface TrustedProxy {
  /** True when `address` (a socket peer) is the proxy. */
  trusts(address: string): boolean;
  /** Re-resolves the proxy's addresses; the gateway calls it on its heartbeat. */
  refresh(): Promise<void>;
}

/** `::ffff:10.0.0.1` and `10.0.0.1` are one client. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return (mapped?.[1] ?? address).toLowerCase();
}

export function clientAddress(request: IncomingMessage, proxy?: TrustedProxy): string {
  const peer = normalizeAddress(request.socket.remoteAddress ?? "unknown");
  if (proxy === undefined || !proxy.trusts(peer)) return peer;
  const header = request.headers["x-forwarded-for"];
  const entries = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",");
  const last = entries.at(-1)?.trim() ?? "";
  return isIP(last) === 0 ? peer : normalizeAddress(last);
}

/**
 * The proxy named by a host name (the Caddy container on the gateway's Docker
 * network) or an IP literal. A name is resolved at start and on each refresh,
 * because the container's address changes when it is recreated; until the
 * first answer, nothing is trusted.
 */
export function trustedProxyByName(
  name: string,
  lookup: (host: string) => Promise<readonly { readonly address: string }[]> = (host) =>
    dnsLookup(host, { all: true }),
): TrustedProxy {
  let addresses = new Set<string>(isIP(name) === 0 ? [] : [normalizeAddress(name)]);
  const proxy: TrustedProxy = {
    trusts: (address) => addresses.has(normalizeAddress(address)),
    async refresh() {
      if (isIP(name) !== 0) return;
      try {
        const answers = await lookup(name);
        addresses = new Set(answers.map((answer) => normalizeAddress(answer.address)));
      } catch {
        // Keep the last answer: a lookup failure must not silently merge every
        // client into Caddy's bucket, nor start trusting someone else.
      }
    },
  };
  return proxy;
}
