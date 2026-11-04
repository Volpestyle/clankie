import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { CONNECTOR_PEER_HEADER } from "@clankie/protocol/connector";
import { afterEach, expect, it } from "vitest";
import { createPublicGateway, type PublicGateway } from "../../gateway/src/gateway.ts";
import { PublicGatewayConnector } from "../src/public-gateway-connector.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// A sign-in over the real doorway: the gateway, the Mac's tunnel and the service.

const hostId = "mac_owner_12345678";
const hostToken = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const quiet = { info: () => {}, warn: () => {} };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function doorway() {
  const host = await createQaService();
  cleanup.push(() => host.close());
  const gateway: PublicGateway = createPublicGateway({
    hostTokens: new Map([[hostId, hostToken]]),
    // Every local test client arrives from loopback, so each names its address
    // the way Caddy does in front of the real gateway.
    trustedProxy: { trusts: () => true, refresh: async () => {} },
    logger: quiet,
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  cleanup.push(() => gateway.close());
  const origin = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
  const connector = new PublicGatewayConnector({
    gatewayUrl: origin,
    hostId,
    hostToken,
    controlPlaneUrl: host.baseUrl,
    relayUrl: host.baseUrl,
    logger: quiet,
  });
  cleanup.push(() => connector.close());
  connector.start();
  const base = `${origin}/h/${hostId}`;
  await expect.poll(async () => (await fetch(`${base}/oauth/register`, register())).status).toBe(201);
  const { client_id: clientId } = (await (await fetch(`${base}/oauth/register`, register())).json()) as {
    client_id: string;
  };

  const signIn = async (address: string, headers: Record<string, string> = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const response = await fetch(`${base}/oauth/authorize?${query.toString()}`, {
      headers: { "x-forwarded-for": address, ...headers },
    });
    const html = await response.text();
    return {
      status: response.status,
      verifier,
      code: /class="code">([A-Z0-9-]+)</u.exec(html)?.[1],
      request: /const id="([^"]+)"/u.exec(html)?.[1],
    };
  };
  const state = async (request: string | undefined) => {
    const response = await fetch(`${base}/oauth/authorize/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
    });
    return (await response.json()) as { status: string; redirect?: string };
  };
  const owner = { authorization: `Bearer ${host.operatorToken}` };
  const waiting = async () => {
    const response = await fetch(`${host.baseUrl}/v1/connector/sign-ins`, { headers: owner });
    return ((await response.json()) as { signIns: Array<{ code: string }> }).signIns.map(({ code }) => code);
  };
  const approve = (code: string | undefined) =>
    fetch(`${host.baseUrl}/v1/connector/sign-ins/approve`, {
      method: "POST",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  return { base, clientId, signIn, state, waiting, approve };
}

function register(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK] }),
  };
}

it("holds each requester to its own share of the waiting sign-ins through the doorway", async () => {
  const { base, clientId, signIn, state, waiting, approve } = await doorway();

  // One requester keeps its newest four, and its oldest page says it has ended.
  const opened = [];
  for (let index = 0; index < 40; index++) opened.push(await signIn("203.0.113.9"));
  expect(opened.every(({ status }) => status === 200)).toBe(true);
  expect((await waiting()).sort()).toEqual(
    opened
      .slice(-4)
      .map(({ code }) => code)
      .sort(),
  );
  expect((await state(opened[0]!.request)).status).toBe("expired");
  expect((await state(opened.at(-1)!.request)).status).toBe("pending");

  // Naming another requester in the request changes nothing.
  for (let index = 0; index < 8; index++)
    await signIn("203.0.113.9", {
      [CONNECTOR_PEER_HEADER]: randomBytes(32).toString("base64url").slice(0, 43),
    });
  expect(await waiting()).toHaveLength(4);

  // Nor do different addresses inside one IPv6 /64.
  for (let index = 1; index <= 8; index++) await signIn(`2001:db8:1:2::${index}`);
  expect(await waiting()).toHaveLength(8);

  // Someone else's sign-in still opens and finishes as it always has.
  const mine = await signIn("198.51.100.7");
  expect(mine.status).toBe(200);
  expect((await approve(mine.code)).status).toBe(200);
  const approved = await state(mine.request);
  expect(approved.status).toBe("approved");
  const redirect = new URL(approved.redirect!);
  const token = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code: redirect.searchParams.get("code")!,
      code_verifier: mine.verifier,
    }).toString(),
  });
  expect(token.status).toBe(200);
});

it("keeps a page someone reloads working, and leaves a decided sign-in alone", async () => {
  const { signIn, state, approve } = await doorway();
  const first = await signIn("198.51.100.7");
  expect((await approve(first.code)).status).toBe(200);
  for (let index = 0; index < 6; index++) expect((await signIn("198.51.100.7")).status).toBe(200);
  expect((await state(first.request)).status).toBe("approved");
});
