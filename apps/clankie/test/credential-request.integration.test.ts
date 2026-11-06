import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ensureOperatorCredential,
  FileCredentialStore,
  rotateOperatorCredential,
} from "@clankie/credential-broker";
import type { CallBrowserToolResult } from "@clankie/protocol";
import { runCredentialsCommand } from "../../tui/src/command/credentials.ts";
import { createClankieApp } from "../src/app.ts";
import { createBrowserHost, type BrowserHost, type CredentialBrowser } from "../src/browser-host.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialRequests } from "../src/credential-requests.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { linearMcp } from "../src/linear-mcp.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

// #245: a hired worker's sign-in request, the owner's no-echo answer over the
// local owner API, and the broker's fill and submit in a real private Chrome,
// against loopback sign-in pages this test owns. Every surface a model, log or
// receipt could see is searched for the secret afterwards.
const SECRET = "Pw-245-never-seen-7f3a";
const USER = "owner-245";
const seen: string[] = [];
const log = (context: Record<string, unknown>, message: string) =>
  seen.push(JSON.stringify({ context, message }));
const logger = { info: log, warn: log, error: log, debug: log };

let root: string;
let host: BrowserHost & CredentialBrowser;
let siteA: Server;
let siteB: Server;
let a: string;
let b: string;
let redirectLogin = false;
const posts: string[] = [];
/** Site A's requests in arrival order: page loads, ticks, typing and probe beacons, posts. */
const events: string[] = [];
const times: number[] = [];
const foreignHits: string[] = [];
let worker: WorkerMcp;
let mcpSession: string;
let app: Awaited<ReturnType<typeof createClankieApp>>["app"];
const intruders: Array<{ kill(): boolean }> = [];
let operatorStore: FileCredentialStore;
let ownerToken: string;

const form = (action = "/session", method = "post") =>
  `<form method="${method}" action="${action}"><input id="user" name="user" type="text"><input id="pass" name="pass" type="password"><button>Sign in</button></form>`;
/** Site A's sign-in page reports what its window can be reached by, and every keystroke (never its value). */
const signInProbe = `<script>
navigator.sendBeacon("/probe?" + new URLSearchParams({ opener: String(window.opener !== null), name: window.name }));
addEventListener("input", () => navigator.sendBeacon("/typed"));
</script>`;
/**
 * A page that reports, once it runs again, when it was frozen and resumed, and
 * whether the window that opened it is gone.
 */
const lifecycle = (id: string) =>
  `<script>let frozenAt = 0;
document.addEventListener("freeze", () => { frozenAt = Date.now(); });
document.addEventListener("resume", () => navigator.sendBeacon("/resumed?" + new URLSearchParams({ id: "${id}", from: frozenAt, to: Date.now(), openerGone: String(!window.opener || window.opener.closed) })));
</script>`;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "clankie-credential-245-"));
  siteB = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      foreignHits.push(`${request.method} ${request.url} ${body}`);
      response.setHeader("content-type", "text/html");
      response.end(`<html><body>${form("/session")}</body></html>`);
    });
  });
  b = await listen(siteB);
  siteA = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const path = request.url ?? "/";
      events.push(`${request.method} ${path}`);
      times.push(Date.now());
      response.setHeader("content-type", "text/html");
      if (request.method === "POST" && path === "/session") {
        posts.push(body);
        response.writeHead(303, { location: "/home", "set-cookie": "session=signed-in; Path=/" }).end();
        return;
      }
      if (/^\/(resumed|typed|probe)\b/u.test(path)) return response.end();
      if (path === "/home")
        return response.end(
          `<p>${/session=signed-in/u.test(request.headers.cookie ?? "") ? "Welcome back" : "Signed out"}</p>${lifecycle("home")}`,
        );
      // A same-origin page the sign-in tab opened before the seal: it keeps that tab as
      // its opener and names it, so it can find it again by reference or by name.
      if (path === "/helper")
        return response.end(`<script>window.opener.name = "pre-seal";</script>${lifecycle("helper")}`);
      // A page that hides its freeze from anyone else listening.
      if (path === "/unfreezable")
        return response.end(
          `<script>addEventListener("freeze", (event) => event.stopImmediatePropagation(), true)</script>${lifecycle("unfreezable")}`,
        );
      if (path === "/login-redirecting" && redirectLogin)
        return response.writeHead(302, { location: `${b}/login` }).end();
      if (path === "/framed") return response.end(`<p>Sign in below</p><iframe src="${b}/login"></iframe>`);
      if (path === "/foreign-action") return response.end(form(`${b}/session`));
      if (path === "/login?helper")
        return response.end(
          `<html><body><button style="position:fixed;left:0;top:0;width:80px;height:80px" onclick="window.open('/helper')">Help</button><div style="margin-top:100px">${form()}</div>${signInProbe}${lifecycle("signin")}</body></html>`,
        );
      response.end(`<html><body>${form()}${signInProbe}</body></html>`);
    });
  });
  a = await listen(siteA);

  // A fixture HOME has no login keychain; Chrome uses its mock one (as browser-public-web).
  const chrome = join(root, "chrome");
  await writeFile(
    chrome,
    `#!/bin/sh\nexec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --use-mock-keychain "$@"\n`,
  );
  await chmod(chrome, 0o755);
  host = await createBrowserHost({
    stateRoot: join(root, "state"),
    attachmentRoot: join(root, "attachments"),
    logger,
    environment: { ...process.env, CLANKIE_BROWSER_EXECUTABLE: chrome },
  });
  const credentialRequests = createCredentialRequests({ browser: host, logger });
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host: createMcpHost({
      trackerMcp: linearMcp,
      credentials,
      settings: { load: async () => ({ mcp: { servers: [] } }) } as never,
      curated: [],
      logger,
    }),
    credentialRequests,
    fleetToolsSnapshot: async () => ({ tools: "connected", assertCurrent() {} }),
  });
  // The service's own owner authentication over a credential store, so rotation is real.
  operatorStore = new FileCredentialStore(join(root, "operator.json"));
  ownerToken = (await ensureOperatorCredential({ store: operatorStore, env: {} })).token;
  ({ app } = await createClankieApp({
    captain: createStubCaptain(),
    credentialRequests,
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      store: operatorStore,
      env: {},
      identity: { operatorId: "owner" },
    }),
  }));
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  mcpSession = init.headers.get("mcp-session-id")!;
}, 60_000);

afterAll(async () => {
  for (const intruder of intruders) intruder.kill();
  await host?.close();
  siteA?.close();
  siteB?.close();
  await rm(root, { recursive: true, force: true });
});

function mcp(method: string, params: unknown) {
  return worker.handleLocalFleet(
    new Request("http://127.0.0.1/v1/fleet/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(mcpSession === undefined ? {} : { "mcp-session-id": mcpSession }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    { fleet: "default", pane: "w-245", validate: async () => true },
  );
}
/** The worker's tool, exactly as its model would read the result. */
async function request(args: Record<string, unknown>): Promise<Record<string, string>> {
  const response = await mcp("tools/call", {
    name: "clankie_call",
    arguments: { name: "clankie_request_credential", arguments: args },
  });
  const text = await response.text();
  seen.push(text);
  return JSON.parse(JSON.parse(text).result.content[0].text);
}
async function browse(conversationId: string, tool: string, args: Record<string, unknown> = {}) {
  const result = (await host.call({ schemaVersion: 1, tool, arguments: args }, undefined, {
    shell: true,
    conversationId,
  })) as CallBrowserToolResult;
  seen.push(JSON.stringify(result));
  return result;
}
const content = (result: CallBrowserToolResult) => (result.outcome === "ok" ? result.content : "");
const currentTab = async (conversationId: string) =>
  JSON.parse(
    content(
      await browse(conversationId, "browser_use_javascript", {
        code: "console.log(JSON.stringify(page.targetId))",
      }),
    ),
  );
/** The owner's CLI over the local owner API, its no-echo reader answering in field order. */
async function owner(args: string[], values: string[] = []) {
  const result = await runCredentialsCommand(args, {
    readValue: async () => values.shift()!,
    ownerFetcher: {
      fetch: async (path, init) =>
        await app.request(path, {
          ...init,
          headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${ownerToken}` },
        }),
    },
  });
  seen.push(JSON.stringify(result));
  return result;
}
const fields = [
  { kind: "username", selector: "#user" },
  { kind: "password", selector: "#pass" },
];
/** A separate process of the owner's user going straight at the browser (fixtures/devtools-intruder.mjs). */
async function startIntruder(sealedTab: string, copied: string[]) {
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "fixtures/devtools-intruder.mjs"),
      join(root, "state", "browser", "profile"),
      sealedTab,
      ...copied,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  intruders.push(child);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await lines.next()).value as string);
  const { held } = (await next()) as { held: number };
  return {
    held,
    go: () => child.stdin.write("go\n"),
    async stop() {
      child.stdin.write("stop\n");
      return (await next()) as { heldOpenAtStop: number; reached: string[]; read: string[] };
    },
  };
}

/** Site A's events from the broker's load of the sign-in page to the form's POST, with their times. */
function fillWindow(from: number) {
  const start = events.indexOf("GET /login?helper", from);
  const end = events.indexOf("POST /session", start);
  return { start, end, during: events.slice(start, end), loginAt: times[start]!, postAt: times[end]! };
}
/** Each page's report once it ran again: when it was frozen and resumed. */
function resumes(from: number) {
  return events
    .slice(from)
    .filter((event) => event.startsWith("POST /resumed?"))
    .map((event) => Object.fromEntries(new URLSearchParams(event.slice("POST /resumed?".length))));
}

it("fills in a new tab of its own while every other page is frozen, then hands back a fresh tab", async () => {
  // The sign-in tab opens a same-origin helper before the seal; the helper holds it as
  // its opener and names it.
  await browse("hire", "browser_use_open", { url: `${a}/login?helper` });
  const sealedTab = await currentTab("hire");
  await browse("hire", "browser_use_click", { x: 40, y: 40 });
  for (let tries = 0; !events.includes("GET /helper") && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await browse("hire", "browser_use_evaluate", { expression: "window.name" })).toMatchObject({
    outcome: "ok",
    content: "pre-seal",
  });
  await browse("other", "browser_use_open", { url: `${a}/home` });
  // Chrome's password manager logs each save decision here, prompt or not.
  await browse("pm", "browser_use_open", { url: "chrome://password-manager-internals" });
  // Machine JavaScript can copy its own endpoint out before a seal.
  const copied = content(
    await browse("other", "browser_use_javascript", { code: "console.log(browser.endpoint)" }),
  ).trim();
  const intruder = await startIntruder(sealedTab, [copied]);
  expect(intruder.held).toBeGreaterThan(0);

  const pending = await request({ conversation: "hire", origin: a, fields });
  expect(pending.outcome).toBe("pending");
  // From the seal through the fill, it keeps trying every direct way into the browser.
  intruder.go();
  expect(pending.note).toContain(`Waiting for sign-in to ${a}`);

  // Sealed: nothing reads the tab, and no conversation runs machine JavaScript.
  for (const tool of [
    "browser_use_read",
    "browser_use_snapshot",
    "browser_use_screenshot",
    "browser_use_evaluate",
  ])
    expect(
      await browse("hire", tool, tool === "browser_use_evaluate" ? { expression: "1" } : {}),
    ).toMatchObject({
      outcome: "refused",
    });
  expect(
    await browse("other", "browser_use_javascript", {
      code: `const t = await browser.send('Target.attachToTarget', {targetId: ${JSON.stringify(sealedTab)}, flatten: true}); console.log(t)`,
    }),
  ).toMatchObject({ outcome: "refused" });
  // Another worker cannot read this request.
  const listed = await owner(["list"]);
  expect(listed).toMatchObject({
    requests: [{ origin: a, requester: "w-245", fields: ["username", "password"] }],
  });

  const from = events.length;
  const answered = await owner(["answer", pending.requestId!], [USER, SECRET]);
  expect(answered).toMatchObject({ outcome: "settled", request: { outcome: "filled" } });
  expect(posts).toContain(`user=${USER}&pass=${SECRET}`);
  // The fill ran in a tab no page could reach: no opener, and not the sealed tab's name.
  const fill = fillWindow(from);
  expect(fill.start).toBeGreaterThan(-1);
  expect(fill.end).toBeGreaterThan(fill.start);
  expect(fill.during).toContain("POST /probe?opener=false&name=");
  expect(fill.during).toContain("POST /typed");
  // Every page that existed before ran again only after the submit, and reports it was
  // frozen before the broker loaded the sign-in page; the helper's opener is gone by then.
  for (let tries = 0; resumes(from).length < 2 && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const reports = resumes(from);
  expect(reports.map((report) => report.id).sort()).toEqual(["helper", "home"]);
  for (const report of reports) {
    expect(Number(report.from)).toBeGreaterThan(0);
    expect(Number(report.from)).toBeLessThanOrEqual(fill.loginAt);
    expect(Number(report.to)).toBeGreaterThanOrEqual(fill.postAt);
  }
  expect(reports.find((report) => report.id === "helper")!.openerGone).toBe("true");
  expect(await intruder.stop()).toEqual({ heldOpenAtStop: 0, reached: [], read: [] });
  const decisions = content(await browse("pm", "browser_use_read"));
  expect(decisions).toContain("Saving disabled");
  expect(decisions).not.toContain("Show password prompt");
  expect(await request({ requestId: pending.requestId! })).toEqual({
    requestId: pending.requestId,
    outcome: "filled",
  });

  // A fresh tab in the same session at the landing page; the tabs that held the secret are gone.
  const tabs = JSON.parse(content(await browse("hire", "browser_use_tabs"))) as Array<{
    targetId: string;
    url: string;
  }>;
  expect(tabs.map((tab) => tab.targetId)).not.toContain(sealedTab);
  expect(tabs.filter((tab) => tab.url.endsWith("/login"))).toEqual([]);
  expect(await currentTab("hire")).not.toBe(sealedTab);
  expect(content(await browse("hire", "browser_use_read"))).toContain("Welcome back");
  await browse("hire", "browser_use_close");
}, 120_000);

it("fails closed when a page cannot be shown frozen, typing nothing", async () => {
  await browse("hire", "browser_use_open", { url: `${a}/login` });
  await browse("stuck", "browser_use_open", { url: `${a}/unfreezable` });
  try {
    const pending = await request({ conversation: "hire", origin: a, fields });
    const before = posts.length;
    const from = events.length;
    expect(await owner(["answer", pending.requestId!], [USER, SECRET])).toMatchObject({
      request: { outcome: "failed", reason: "page_not_frozen" },
    });
    // The broker never loaded the page, let alone typed.
    expect(events.slice(from).filter((event) => !event.startsWith("POST /resumed"))).toEqual([]);
    expect(posts.length).toBe(before);
    // And nothing stays frozen behind it.
    for (let tries = 0; !resumes(from).some((report) => report.id === "unfreezable") && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resumes(from).map((report) => report.id)).toContain("unfreezable");
  } finally {
    await browse("stuck", "browser_use_close");
  }
}, 120_000);

it("stops the fill when the owner credential rotates while the answer body is pending", async () => {
  await browse("hire", "browser_use_open", { url: `${a}/login` });
  const pending = await request({ conversation: "hire", origin: a, fields });
  const before = posts.length;
  const from = events.length;
  let reading!: () => void;
  const bodyRead = new Promise<void>((resolve) => (reading = resolve));
  let send!: (chunk: Uint8Array) => void;
  let finish!: () => void;
  // No eager pull: the stream is pulled only once the route reads the body.
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        send = (chunk) => controller.enqueue(chunk);
        finish = () => controller.close();
      },
      pull() {
        reading();
      },
    },
    { highWaterMark: 0 },
  );
  const answering = app.request(`/v1/credential-requests/${pending.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body,
    duplex: "half",
  } as RequestInit);
  await bodyRead;
  // The owner rotates the credential this answer authenticated with; the body arrives after.
  ownerToken = (await rotateOperatorCredential({ store: operatorStore, env: {} })).token;
  send(new TextEncoder().encode(JSON.stringify({ values: { username: USER, password: SECRET } })));
  finish();
  const answered = (await (await answering).json()) as Record<string, unknown>;
  seen.push(JSON.stringify(answered));
  expect(answered).toMatchObject({
    outcome: "settled",
    request: { outcome: "failed", reason: "owner_unavailable" },
  });
  // Nothing typed, nothing posted.
  expect(events.slice(from)).not.toContain("POST /typed");
  expect(posts.length).toBe(before);
}, 120_000);

it("refuses a wrong origin, a redirect to another origin, another origin's frame or form action", async () => {
  await browse("hire", "browser_use_open", { url: `${a}/login` });
  expect(await request({ conversation: "hire", origin: b, fields })).toMatchObject({
    outcome: "failed",
    reason: "wrong_origin",
  });
  // Never sealed: the tab still reads.
  expect(await browse("hire", "browser_use_read")).toMatchObject({ outcome: "ok", isError: false });

  const cases: Array<[string, string, () => void]> = [
    ["/login-redirecting", "wrong_origin", () => (redirectLogin = true)],
    ["/framed", "field_not_found", () => {}],
    ["/foreign-action", "form_action_origin", () => {}],
  ];
  for (const [path, reason, between] of cases) {
    redirectLogin = false;
    await browse("hire", "browser_use_open", { url: `${a}${path}` });
    const tab = await currentTab("hire");
    const pending = await request({ conversation: "hire", origin: a, fields });
    expect(pending.outcome).toBe("pending");
    between();
    expect(await owner(["answer", pending.requestId!], [USER, SECRET])).toMatchObject({
      request: { outcome: "failed", reason },
    });
    // Retired even though nothing was submitted: the tab never comes back.
    expect(await currentTab("hire")).not.toBe(tab);
    expect(content(await browse("hire", "browser_use_tabs"))).not.toContain(tab);
  }
  expect(foreignHits.join("\n")).not.toContain(SECRET);
}, 180_000);

it("refuses closed and replaced requests, and a decline returns the untouched tab", async () => {
  await browse("hire", "browser_use_open", { url: `${a}/login` });
  const tab = await currentTab("hire");
  const before = posts.length;

  const withdrawn = await request({ conversation: "hire", origin: a, fields });
  expect(await request({ requestId: withdrawn.requestId!, withdraw: true })).toMatchObject({
    outcome: "failed",
    reason: "withdrawn",
  });
  expect(await owner(["answer", withdrawn.requestId!], [USER, SECRET])).toEqual({
    outcome: "refused",
    reason: "closed",
  });

  const first = await request({ conversation: "hire", origin: a, fields });
  const second = await request({ conversation: "hire", origin: a, fields });
  expect(await request({ requestId: first.requestId! })).toMatchObject({
    outcome: "failed",
    reason: "replaced",
  });
  expect(await owner(["answer", first.requestId!], [USER, SECRET])).toEqual({
    outcome: "refused",
    reason: "closed",
  });
  expect(await owner(["decline", second.requestId!])).toMatchObject({ request: { outcome: "declined" } });
  expect(await request({ requestId: second.requestId! })).toEqual({
    requestId: second.requestId,
    outcome: "declined",
  });
  expect(await currentTab("hire")).toBe(tab);
  expect(posts.length).toBe(before);
}, 120_000);

it("leaves the secret in no transcript, log, receipt or state file", async () => {
  expect(seen.join("\n")).not.toContain(SECRET);
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(root);
  const holding = [];
  for (const file of files) if ((await readFile(file)).includes(SECRET)) holding.push(file);
  expect(holding).toEqual([]);
});
