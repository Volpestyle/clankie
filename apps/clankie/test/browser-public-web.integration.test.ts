import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallBrowserToolResult } from "@clankie/protocol";
import { createBrowserHost, type BrowserHost } from "../src/browser-host.ts";
import { isPublicAddress } from "../src/browser-public-web.ts";

// VUH-2590: a real Chrome behind the real browser host. The "public" fixture is a
// loopback server the test seam classifies as public; the "private" fixture keeps
// the production classification and must never see a request from a social turn.
const logger = { info: () => {}, warn: () => {} };
const SECRET = "LOOPBACK-SECRET-2590";
let stateRoot: string;
let host: BrowserHost;
let publicServer: Server;
let privateServer: Server;
let publicPort: number;
let privatePort: number;
const privateHits: string[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// The fixture HOME has no login keychain, and a persistent Chrome profile blocks
// on it, so on macOS the test launches Chrome with its mock keychain.
async function testEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== "darwin") return process.env;
  const chrome = join(stateRoot, "chrome");
  await writeFile(
    chrome,
    `#!/bin/sh\nexec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --use-mock-keychain "$@"\n`,
  );
  await chmod(chrome, 0o755);
  return { ...process.env, CLANKIE_BROWSER_EXECUTABLE: chrome };
}

beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "clankie-browser-public-web-"));
  privateServer = createServer((request, response) => {
    privateHits.push(request.url ?? "");
    response.setHeader("content-type", "text/html");
    response.end(`<p>${SECRET}</p>`);
  });
  privatePort = await listen(privateServer);
  publicServer = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${privatePort}/via-redirect` }).end();
      return;
    }
    if (path === "/redirect-dns") {
      response.writeHead(302, { location: `http://rebind.test:${privatePort}/via-dns` }).end();
      return;
    }
    if (path === "/redirect-file") {
      response.writeHead(302, { location: "file:///etc/hosts" }).end();
      return;
    }
    if (path === "/login") response.setHeader("set-cookie", "owner_session=signed-in; Path=/; Max-Age=3600");
    response.setHeader("content-type", "text/html");
    response.end(
      path === "/frame"
        ? `<p>public page</p><iframe src="http://127.0.0.1:${privatePort}/via-frame"></iframe>`
        : "<p>public page</p>",
    );
  });
  publicPort = await listen(publicServer);
  host = await createBrowserHost({
    stateRoot,
    attachmentRoot: stateRoot,
    logger,
    environment: await testEnvironment(),
    publicWeb: {
      isPublicAddress: (address, port) => address === "127.0.0.1" && port === publicPort,
      lookup: async (hostname) => (hostname === "rebind.test" ? ["127.0.0.1"] : ["93.184.215.14"]),
    },
  });
}, 60_000);

afterAll(async () => {
  await host?.close();
  await new Promise((resolve) => publicServer?.close(resolve));
  await new Promise((resolve) => privateServer?.close(resolve));
  await rm(stateRoot, { recursive: true, force: true });
}, 60_000);

const social = { conversationId: "discord-room", shell: false };
const owner = { conversationId: "owner-operator", shell: true };
const call = (tool: string, args: Record<string, unknown>, authority: typeof social) =>
  host.call({ schemaVersion: 1, tool, arguments: args }, undefined, authority);
const text = (result: CallBrowserToolResult) =>
  result.outcome === "ok" ? result.content : `${result.reason}: ${result.detail ?? ""}`;
const publicUrl = (path: string) => `http://127.0.0.1:${publicPort}${path}`;

describe("browser in a turn without machine access", () => {
  it("refuses file, browser-internal, script and private URLs before navigating", async () => {
    for (const url of [
      "file:///etc/hosts",
      "chrome://settings/",
      "data:text/html,<p>hi</p>",
      "javascript:alert(1)",
      "view-source:https://example.com/",
      `http://127.0.0.1:${privatePort}/direct`,
      `http://localhost:${privatePort}/direct`,
      `http://[::1]:${privatePort}/direct`,
      "http://printer.local/",
      "http://192.168.1.1/",
      "http://10.0.0.8/",
      "http://169.254.169.254/latest/meta-data/",
      `http://rebind.test:${privatePort}/direct`,
    ]) {
      const result = await call("browser_use_read", { url }, social);
      expect(result, url).toMatchObject({ outcome: "refused", reason: "doctrine_denied" });
    }
    expect(privateHits).toEqual([]);
  }, 60_000);

  it("refuses redirects, frames and page scripts that reach private addresses", async () => {
    for (const path of ["/redirect", "/redirect-dns", "/redirect-file"]) {
      const result = await call("browser_use_read", { url: publicUrl(path) }, social);
      expect(text(result), path).not.toContain(SECRET);
      expect(text(result), path).not.toContain("localhost");
    }
    const framed = await call("browser_use_read", { url: publicUrl("/frame") }, social);
    expect(text(framed)).toContain("public page");
    const fetched = await call(
      "browser_use_evaluate",
      {
        expression: `fetch("http://127.0.0.1:${privatePort}/via-fetch").then((r) => r.text(), (e) => "blocked: " + e.message)`,
      },
      social,
    );
    expect(text(fetched)).not.toContain(SECRET);
    await call("browser_use_evaluate", { expression: `location.href = "file:///etc/hosts"; "sent"` }, social);
    const afterFile = await call("browser_use_read", {}, social);
    expect(text(afterFile)).not.toContain("localhost");
    expect(privateHits).toEqual([]);
  }, 90_000);

  it("browses logged out, without the owner profile's cookies", async () => {
    const signedIn = await call("browser_use_read", { url: publicUrl("/login") }, owner);
    expect(signedIn).toMatchObject({ outcome: "ok", isError: false });
    const ownerCookies = await call("browser_use_evaluate", { expression: "document.cookie" }, owner);
    expect(text(ownerCookies)).toContain("owner_session=signed-in");

    await call("browser_use_read", { url: publicUrl("/") }, social);
    const roomCookies = await call("browser_use_evaluate", { expression: "document.cookie" }, social);
    expect(roomCookies).toMatchObject({ outcome: "ok", isError: false });
    expect(text(roomCookies)).not.toContain("owner_session");
    for (const args of [{ isolated: false }, { headed: true }])
      expect(await call("browser_use_open", args, social)).toMatchObject({
        outcome: "refused",
        reason: "doctrine_denied",
      });
    expect(await call("browser_use_javascript", { code: "console.log(1)" }, social)).toMatchObject({
      outcome: "refused",
      reason: "approval_required",
    });
  }, 90_000);

  it("classifies loopback, private, link-local and tailnet addresses as private by default", async () => {
    const plain = await createBrowserHost({ stateRoot, attachmentRoot: stateRoot, logger });
    try {
      for (const url of [
        `http://127.0.0.1:${publicPort}/`,
        "http://0.0.0.0/",
        "http://172.20.0.1/",
        "http://100.101.102.103/",
        "http://[fe80::1]/",
        "http://[fd00::1]/",
        "http://[::ffff:127.0.0.1]/",
        "https://router.local./",
      ]) {
        const result = await plain.call(
          { schemaVersion: 1, tool: "browser_use_open", arguments: { url } },
          undefined,
          social,
        );
        expect(result, url).toMatchObject({ outcome: "refused", reason: "doctrine_denied" });
      }
    } finally {
      await plain.close();
    }
    // Public answers stay public, including the IPv4-mapped form Chrome may connect to.
    for (const address of ["172.66.147.243", "8.8.8.8", "2606:4700::1", "::ffff:8.8.8.8"])
      expect(isPublicAddress(address), address).toBe(true);
  });

  it("leaves machine-authorized turns on today's browser", async () => {
    const before = privateHits.length;
    const result = await call("browser_use_read", { url: `http://127.0.0.1:${privatePort}/owner` }, owner);
    expect(text(result)).toContain(SECRET);
    expect(privateHits.slice(before)).toContain("/owner");
  }, 60_000);
});
