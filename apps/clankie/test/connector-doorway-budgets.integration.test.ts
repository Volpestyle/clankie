import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { resolve } from "node:path";
import type {
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
} from "@clankie/protocol";
import { afterEach, expect, it } from "vitest";
import { createPublicGateway } from "../../gateway/src/gateway.ts";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { PublicGatewayConnector } from "../src/public-gateway-connector.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// The doorway's connector budgets over the real path: gateway, the Mac's tunnel,
// the service's sign-in and the relay's MCP. The gateway's clock stands still until
// a test moves it, so no budget refills while a test spends it. Each caller names its address the way
// Caddy does in front of the real gateway.

const hostId = "mac_owner_12345678";
const hostToken = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const OWNER_BROWSER = "198.51.100.7";
const CLAUDE_SERVER = "203.0.113.50";
const quiet = { info: () => {}, warn: () => {} };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function doorway() {
  const host = await createQaService();
  cleanup.push(() => host.close());
  const authorizeDevice = new ControlPlaneDeviceAuthorizer({ baseUrl: host.baseUrl });
  const dispatch = async (
    request: OperatorConversationServiceRequest,
  ): Promise<OperatorConversationServiceResult> => {
    if (request.op === "fleet")
      return {
        op: "fleet",
        schemaVersion: 1,
        snapshot: { schemaVersion: 1, cursor: "c1", seats: [], personas: [], channels: [] },
      };
    throw new Error(`unexpected ${request.op}`);
  };
  let relayUrl = "";
  const operator = createOperatorConversationRelayHandler({ authorizeDevice, dispatch });
  const mcp = createConnectorMcpHandler({
    authorizeDevice,
    operator: createLoopbackConnectorOperator("http://placeholder.invalid", (input, init) =>
      fetch(new URL(new URL(String(input)).pathname, relayUrl), init),
    ),
    localAuthorizationServer: host.baseUrl,
    version: "test",
    guide: new ClankieGuide(resolve(import.meta.dirname, "../../..")),
  });
  const relay = createServer((request, response) => {
    void (async () => {
      if (await mcp(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relayUrl = await listen(relay);
  cleanup.push(() => void relay.close());

  let now = 1_800_000_000_000;
  const gateway = createPublicGateway({
    hostTokens: new Map([[hostId, hostToken]]),
    trustedProxy: { trusts: () => true, refresh: async () => {} },
    clock: () => now,
    logger: quiet,
  });
  const origin = await listen(gateway.server);
  cleanup.push(() => gateway.close());
  const connectMac = () => {
    const connector = new PublicGatewayConnector({
      gatewayUrl: origin,
      hostId,
      hostToken,
      controlPlaneUrl: host.baseUrl,
      relayUrl,
      logger: quiet,
    });
    cleanup.push(() => connector.close());
    connector.start();
    return connector;
  };
  let connector = connectMac();
  const reconnectMac = () => {
    connector.close();
    connector = connectMac();
  };

  const base = `${origin}/h/${hostId}`;
  const from = (address: string, headers: Record<string, string> = {}) => ({
    "x-forwarded-for": address,
    ...headers,
  });
  const registration = () =>
    fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: from(CLAUDE_SERVER, { "content-type": "application/json" }),
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK] }),
    });
  await expect.poll(async () => (await registration()).status).toBe(201);
  const { client_id: clientId } = (await (await registration()).json()) as { client_id: string };

  const open = async (address: string) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const response = await fetch(`${base}/oauth/authorize?${query.toString()}`, { headers: from(address) });
    expect(response.status).toBe(200);
    const html = await response.text();
    return {
      verifier,
      code: /class="code">([A-Z0-9-]+)</u.exec(html)![1]!,
      request: /const id="([^"]+)"/u.exec(html)![1]!,
    };
  };
  const poll = (address: string, request: string) =>
    fetch(`${base}/oauth/authorize/status`, {
      method: "POST",
      headers: from(address, { "content-type": "application/json" }),
      body: JSON.stringify({ request }),
    });
  const approve = async (code: string) => {
    const response = await fetch(`${host.baseUrl}/v1/connector/sign-ins/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);
  };
  const token = (form: Record<string, string>, encoding: Encoding = "form", address = CLAUDE_SERVER) => {
    // The caller's fields come first, so a byte order mark lands on the credential.
    const fields = { ...form, client_id: clientId };
    const json = encoding.startsWith("json");
    return fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: from(address, {
        "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      }),
      body: `${encoding.endsWith("bom") ? "\uFEFF" : ""}${
        json ? JSON.stringify(fields) : new URLSearchParams(fields).toString()
      }`,
    });
  };
  /** Waits for the owner's approval as the page does, then exchanges as Claude's server does. */
  const finish = async (signIn: Awaited<ReturnType<typeof open>>, encoding: Encoding = "form") => {
    await approve(signIn.code);
    const approved = (await (await poll(OWNER_BROWSER, signIn.request)).json()) as { redirect: string };
    return token(
      {
        code: new URL(approved.redirect).searchParams.get("code")!,
        grant_type: "authorization_code",
        redirect_uri: CALLBACK,
        code_verifier: signIn.verifier,
      },
      encoding,
    );
  };
  const toolList = (bearer: string, address = CLAUDE_SERVER) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: from(address, {
        authorization: `Bearer ${bearer}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const discovery = (address: string) =>
    fetch(`${base}/.well-known/oauth-authorization-server`, { headers: from(address) });
  /** Spends the anonymous lane from many sources, each inside its own budget. */
  const drainAnonymous = async () => {
    for (let index = 0; index < 130; index++) await discovery(`192.0.2.${index}`);
    expect((await discovery("192.0.2.200")).status).toBe(429);
  };
  /** A token request whose body never finishes arriving; the socket stays open. */
  const stalledToken = async (address: string, declaredBytes = 100) => {
    const { hostname, port } = new URL(origin);
    const socket = connect(Number(port), hostname);
    cleanup.push(() => void socket.destroy());
    await once(socket, "connect");
    socket.write(
      `POST /h/${hostId}/oauth/token HTTP/1.1\r\nhost: gateway\r\nx-forwarded-for: ${address}\r\n` +
        `content-type: application/x-www-form-urlencoded\r\ncontent-length: ${declaredBytes}\r\n\r\npartial`,
    );
    return socket;
  };
  return {
    open,
    poll,
    finish,
    token,
    toolList,
    discovery,
    drainAnonymous,
    stalledToken,
    reconnectMac,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Encoding = "form" | "json" | "form-bom" | "json-bom";

/** What the gateway said before closing, or nothing if it still holds the socket after `waitMs`. */
async function refusal(socket: Socket, waitMs: number): Promise<string | undefined> {
  let received = "";
  socket.on("data", (data: Buffer) => {
    received += data.toString("utf8");
  });
  const closed = once(socket, "close").then(() => true);
  const held = new Promise<boolean>((done) => setTimeout(() => done(false), waitMs));
  return (await Promise.race([closed, held])) ? received.split("\r\n", 1)[0] : undefined;
}

interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
}

it("keeps signed-in work and a sign-in under way moving through a flood from many sources", async () => {
  const { open, poll, finish, token, toolList, discovery } = await doorway();

  const first = await open(OWNER_BROWSER);
  const issued = await finish(first);
  expect(issued.status).toBe(200);
  const tokens = (await issued.json()) as Tokens;
  expect((await toolList(tokens.access_token)).status).toBe(200);
  const second = await open(OWNER_BROWSER);

  // Every source stays well inside its own budget; together they drain the host.
  const statuses: number[] = [];
  for (let index = 0; index < 240; index++) {
    const source = `192.0.2.${index}`;
    const call = [
      () => discovery(source),
      () => toolList(`junk-${index}`, source),
      () => poll(source, "not-a-sign-in"),
    ][index % 3]!;
    statuses.push((await call()).status);
  }
  expect(statuses).toContain(429);
  expect((await discovery("192.0.2.250")).status).toBe(429);
  // A made-up bearer never reached the Mac's approval, so it earned nothing.
  expect((await toolList("junk-0", "192.0.2.0")).status).toBe(429);

  expect((await toolList(tokens.access_token)).status).toBe(200);
  expect((await poll(OWNER_BROWSER, second.request)).status).toBe(200);
  const finished = await finish(second);
  expect(finished.status).toBe(200);
  expect((await toolList(((await finished.json()) as Tokens).access_token)).status).toBe(200);

  // A refresh and the token it brings carry on in the same flood.
  const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  expect(refreshed.status).toBe(200);
  expect((await toolList(((await refreshed.json()) as Tokens).access_token)).status).toBe(200);
});

it("spends nothing shared on a call its source's own budget refuses", async () => {
  const { poll, discovery } = await doorway();

  const noisy: number[] = [];
  for (let index = 0; index < 300; index++) noisy.push((await poll("192.0.2.1", "unknown")).status);
  expect(noisy.filter((status) => status === 200).length).toBeLessThanOrEqual(60);
  expect(noisy.at(-1)).toBe(429);

  // Those refusals left the host's budget for everyone else.
  expect((await discovery("192.0.2.2")).status).toBe(200);
});

it("counts one IPv6 /64 as one source", async () => {
  const { discovery } = await doorway();

  const statuses: number[] = [];
  for (let index = 1; index <= 80; index++)
    statuses.push((await discovery(`2001:db8:1:2::${index.toString(16)}`)).status);
  expect(statuses.at(-1)).toBe(429);
  expect((await discovery("2001:db8:1:3::1")).status).toBe(200);
});

it("recognises a credential in a JSON token request as the Mac does", async () => {
  const { open, finish, token, toolList, drainAnonymous } = await doorway();
  const first = await open(OWNER_BROWSER);
  const issued = (await (await finish(first)).json()) as Tokens;
  const second = await open(OWNER_BROWSER);
  const signIns = [await open(OWNER_BROWSER), await open(OWNER_BROWSER)];
  await drainAnonymous();

  const exchanged = await finish(second, "json");
  expect(exchanged.status).toBe(200);
  expect((await toolList(((await exchanged.json()) as Tokens).access_token)).status).toBe(200);
  // Each refresh rotates the token the next one presents.
  let refreshToken = issued.refresh_token;
  for (const encoding of ["json", "json-bom", "form-bom"] as const) {
    const refreshed = await token({ refresh_token: refreshToken, grant_type: "refresh_token" }, encoding);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Tokens;
    expect((await toolList(next.access_token)).status).toBe(200);
    refreshToken = next.refresh_token;
  }
  for (const encoding of ["json-bom", "form-bom"] as const) {
    const exchanged = await finish(signIns.shift()!, encoding);
    expect(exchanged.status).toBe(200);
  }

  // A form that names nothing the Mac vouched for stays anonymous.
  expect((await token({ grant_type: "refresh_token", refresh_token: "junk" }, "json")).status).toBe(429);
});

it("bounds token bodies that never finish, and keeps refreshes moving past them", async () => {
  const { open, finish, token, toolList, stalledToken } = await doorway();
  const issued = (await (await finish(await open(OWNER_BROWSER))).json()) as Tokens;

  // One source holds a few reads; the rest are turned away at once.
  const noisy = await Promise.all(Array.from({ length: 12 }, () => stalledToken("192.0.2.1")));
  const answers = await Promise.all(noisy.map((socket) => refusal(socket, 300)));
  expect(answers.filter((answer) => answer?.includes("429"))).toHaveLength(8);

  // A declared size over the limit is refused without waiting for a byte of it.
  expect(await refusal(await stalledToken("192.0.2.2", 9_000), 1_000)).toContain("413");

  // Many sources fill the reads anyone may take.
  const many = await Promise.all(Array.from({ length: 70 }, (_, index) => stalledToken(`198.18.0.${index}`)));
  const crowded = await Promise.all(many.map((socket) => refusal(socket, 300)));
  expect(crowded.some((answer) => answer?.includes("429"))).toBe(true);
  expect(
    (await token({ grant_type: "refresh_token", refresh_token: "junk" }, "form", "198.18.1.1")).status,
  ).toBe(429);

  // Signed-in work needs no read slot, and a known client's refresh has its own.
  expect((await toolList(issued.access_token)).status).toBe(200);
  const refreshed = await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token });
  expect(refreshed.status).toBe(200);

  // The deadline ends every held read and gives its room back.
  expect(await refusal(noisy.find((socket) => !socket.destroyed)!, 4_000)).toContain("408");
  await expect
    .poll(
      async () =>
        (await token({ grant_type: "refresh_token", refresh_token: "junk" }, "form", "198.18.1.1")).status,
      {
        timeout: 5_000,
      },
    )
    .toBe(400);
}, 20_000);

it("gives a read back when its client hangs up", async () => {
  const { token, stalledToken } = await doorway();
  const held = await Promise.all(Array.from({ length: 4 }, () => stalledToken("192.0.2.1")));
  await refusal(held[0]!, 200);
  const junk = { grant_type: "refresh_token", refresh_token: "junk" };
  expect((await token(junk, "form", "192.0.2.1")).status).toBe(429);
  for (const socket of held) socket.destroy();
  await expect.poll(async () => (await token(junk, "form", "192.0.2.1")).status).toBe(400);
});

it("forgets a client when its Mac's connection ends or its token ages out, leaving the Mac in charge", async () => {
  const { open, finish, toolList, drainAnonymous, reconnectMac, advance } = await doorway();
  const issued = (await (await finish(await open(OWNER_BROWSER))).json()) as Tokens;
  await drainAnonymous();
  expect((await toolList(issued.access_token)).status).toBe(200);

  reconnectMac();
  await expect.poll(async () => (await toolList(issued.access_token)).status).toBe(429);

  // Once the budget refills, the Mac's answer teaches the gateway again.
  advance(11 * 60_000);
  expect((await toolList(issued.access_token)).status).toBe(200);
  expect((await toolList("junk")).status).toBe(401);
  await drainAnonymous();
  expect((await toolList(issued.access_token)).status).toBe(200);

  advance(3 * 60 * 60_000);
  await drainAnonymous();
  expect((await toolList(issued.access_token)).status).toBe(429);
});
