/**
 * The public web a turn without machine access may browse (VUH-2590). Such turns use
 * their own throwaway Chrome, never the owner's profile. It sends every request
 * through this proxy and keeps WebRTC off direct UDP, so the address check covers
 * navigations, redirects, frames, popups, page scripts and peer connections.
 * The proxy connects to the address it checked, so DNS rebinding cannot swap it.
 */
import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { BlockList, connect, isIP, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export interface PublicWebOptions {
  /** DNS resolution; a test may map fixture names. */
  lookup?: (hostname: string) => Promise<readonly string[]>;
  /** Address classification; a test may treat one local fixture as public. */
  isPublicAddress?: (address: string, port: number) => boolean;
}

// BlockList matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 rules, and IPv4
// against IPv6 rules covering ::ffff:0:0/96, so that range must stay out of the list.
const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  privateRanges.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  privateRanges.addSubnet(network, prefix, "ipv6");

/** Loopback, RFC1918, link-local, CGNAT/tailnet, multicast and other special-use addresses are private. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !privateRanges.check(address, family === 4 ? "ipv4" : "ipv6");
}

function hostOf(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.+$/u, "");
}

function privateName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local");
}

/** Why a URL is outside the public web without resolving it, or undefined. */
export function nonPublicUrl(raw: string, options: PublicWebOptions = {}): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return `${url.protocol} URLs are outside the public web`;
  const host = hostOf(url.hostname);
  if (privateName(host)) return `${host} is a local name`;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (isIP(host) && !(options.isPublicAddress ?? isPublicAddress)(host, port))
    return `${host} is a private address`;
  return undefined;
}

/** The checked address to connect to, or a refusal naming why. */
async function resolvePublic(
  hostname: string,
  port: number,
  options: PublicWebOptions,
): Promise<{ address: string } | { refused: string }> {
  const host = hostOf(hostname);
  if (privateName(host)) return { refused: `${host} is a local name` };
  const isPublic = options.isPublicAddress ?? isPublicAddress;
  let addresses: readonly string[];
  if (isIP(host)) addresses = [host];
  else
    try {
      addresses = options.lookup
        ? await options.lookup(host)
        : (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      return { refused: `${host} did not resolve` };
    }
  if (addresses.length === 0) return { refused: `${host} did not resolve` };
  // One private answer refuses the name: the page must not choose which one Chrome reaches.
  const blocked = addresses.find((address) => !isPublic(address, port));
  if (blocked !== undefined)
    return { refused: blocked === host ? `${host} is a private address` : `${host} resolves to ${blocked}` };
  return { address: addresses[0]! };
}

/** Check a URL the way the proxy will, including DNS. */
export async function refusePublicWebUrl(
  raw: string,
  options: PublicWebOptions = {},
): Promise<string | undefined> {
  const early = nonPublicUrl(raw, options);
  if (early !== undefined) return early;
  const url = new URL(raw);
  const result = await resolvePublic(
    url.hostname,
    Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    options,
  );
  return "refused" in result ? result.refused : undefined;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));
}
const refusalBody = (reason: string) =>
  `Clankie refused this address: a turn without machine access browses only the public web (${reason}).\n`;

export interface PublicWebProxy {
  /** `http://127.0.0.1:PORT`, for a browser context's `proxyServer`. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startPublicWebProxy(
  options: PublicWebOptions & {
    logger: { warn(context: Record<string, unknown>, message: string): void };
  },
): Promise<PublicWebProxy> {
  const refusedLog = (target: string, reason: string) =>
    options.logger.warn({ event: "browser.public_web.refused", target, reason }, "private address refused");
  const tunnels = new Set<Duplex>();
  const server = createServer((request, response) => {
    response.on("error", () => {});
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:") {
      response.writeHead(400).end();
      return;
    }
    const port = Number(target.port || 80);
    void resolvePublic(target.hostname, port, options).then((resolved) => {
      if ("refused" in resolved) {
        refusedLog(target.host, resolved.refused);
        response
          .writeHead(403, { "content-type": "text/plain; charset=utf-8" })
          .end(refusalBody(resolved.refused));
        return;
      }
      const upstream = httpRequest(
        {
          host: resolved.address,
          port,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers: { ...endToEnd(request.headers), host: target.host },
          setHost: false,
        },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.statusMessage, endToEnd(reply.headers));
          reply.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.destroy();
      });
      request.pipe(upstream);
    });
  });
  // Chrome tunnels https and WebSockets through CONNECT; TLS stays end to end.
  server.on("connect", (request, socket, head) => {
    socket.on("error", () => {});
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(request.url ?? "");
    const port = Number(match?.[2]);
    if (!match || port < 1 || port > 65_535) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    void resolvePublic(match[1]!, port, options).then((resolved) => {
      if ("refused" in resolved) {
        refusedLog(request.url ?? "", resolved.refused);
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = connect(port, resolved.address, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of tunnels) socket.destroy();
      }),
  };
}

export interface PublicWebChrome {
  /** The browser-level CDP endpoint. */
  readonly endpoint: string;
  close(): Promise<void>;
}

async function chromeExecutable(configured: string | undefined): Promise<string> {
  const candidates = configured
    ? [configured]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe")]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates)
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  throw new Error("Chrome not found. Install Chrome or set CLANKIE_BROWSER_EXECUTABLE.");
}

/**
 * Launch the headless Chrome for turns without machine access, with a fresh profile
 * that is deleted on close. WebRTC's IP-handling policy is a whole-browser switch,
 * which is why this is a separate process from the owner's Chrome.
 */
export async function launchPublicWebChrome(options: {
  root: string;
  proxy: PublicWebProxy;
  executablePath?: string | undefined;
}): Promise<PublicWebChrome> {
  const executable = await chromeExecutable(options.executablePath);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const profile = await mkdtemp(join(options.root, "public-"));
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--window-size=1440,900",
      `--proxy-server=${options.proxy.url}`,
      // Chrome bypasses proxies for loopback unless told not to.
      "--proxy-bypass-list=<-loopback>",
      // WebRTC uses only proxied TCP, so ICE/STUN reaches no address the proxy refused.
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      // A throwaway profile needs no secret store; never touch the owner's keychain.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      ...(process.platform === "linux" ? ["--password-store=basic"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let launchError: Error | undefined;
  child.on("error", (error) => {
    launchError = error;
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(timer);
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    })());
  try {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Chrome exited before exposing CDP.");
      const published = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
      const [port, path] = published.trim().split("\n");
      if (port && /^\d+$/u.test(port) && path?.startsWith("/devtools/browser/"))
        return { endpoint: `ws://127.0.0.1:${port}${path}`, close };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Chrome did not expose CDP within 15000 ms.");
  } catch (error) {
    await close();
    throw error;
  }
}
