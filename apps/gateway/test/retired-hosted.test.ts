import { execFile } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PublicGatewayTunnelFrameSchema,
  derivePublicGatewayHostId,
  type PublicGatewayRequestFrame,
} from "@clankie/protocol/public-gateway";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createPublicGateway } from "../src/gateway.ts";

const GATEWAY_ROOT = new URL("..", import.meta.url).pathname;

// Hosted Clankie is gone: its plaintext routes and its fleet-signed host
// credentials must reach no Mac, whichever way the Mac signed in.
const ACCOUNT = "acct-signed-in";
const INSTALLATION = "i".repeat(22);
const ACCOUNT_HOST = derivePublicGatewayHostId(ACCOUNT, INSTALLATION);
const ACCESS_TOKEN = "signed-access";
const MAC_HOST = "mac_james_12345678";
const MAC_TOKEN = "gateway-host-token-that-is-longer-than-thirty-two-characters";
// The protocol still names the first four (the public service serves them
// inside encrypted envelopes), so plaintext gets 426; the wake routes are gone.
const RETIRED_POST_ROUTES = [
  ["/v1/hosted/pair-offer", 426],
  ["/v1/hosted/support", 426],
  ["/v1/hosted/operator", 426],
  ["/v1/discord/ingress", 426],
  ["/v1/gateway/wake", 404],
  ["/v1/gateway/wake/challenge", 404],
] as const;

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup() {
  const gateway = createPublicGateway({
    hostTokens: new Map([[MAC_HOST, MAC_TOKEN]]),
    accountConfig: {
      schemaVersion: 1,
      account: {
        provider: "cognito_email_otp",
        endpoint: "https://cognito-idp.us-east-1.amazonaws.com",
        issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
        clientId: "client123",
        selfSignUpEnabled: false,
      },
    },
    authenticateAccountToken: async (token) => {
      if (token !== ACCESS_TOKEN) throw new Error("denied");
      return { accountId: ACCOUNT, expiresAtMs: Date.now() + 60_000 };
    },
  });
  closers.push(() => gateway.close());
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const origin = `http://127.0.0.1:${String((gateway.server.address() as AddressInfo).port)}`;
  const connect = async (query: string, token: string): Promise<WebSocket | number> => {
    const socket = new WebSocket(
      `${origin.replace("http", "ws")}${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?${query}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    closers.push(() => socket.close());
    return await new Promise((resolve) => {
      socket.once("open", () => resolve(socket));
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", () => resolve(0));
    });
  };
  return { origin, connect };
}

/** Answers every request frame, and records what arrived. */
function serve(socket: WebSocket): PublicGatewayRequestFrame[] {
  const seen: PublicGatewayRequestFrame[] = [];
  socket.on("message", (data: Buffer) => {
    const frame = PublicGatewayTunnelFrameSchema.parse(JSON.parse(data.toString()));
    if (frame.kind !== "request") return;
    seen.push(frame);
    socket.send(
      JSON.stringify({
        schemaVersion: 1,
        kind: "response_start",
        requestId: frame.requestId,
        status: 200,
        headers: [],
      }),
    );
    socket.send(JSON.stringify({ schemaVersion: 1, kind: "response_end", requestId: frame.requestId }));
  });
  return seen;
}

async function connectBoth(connect: Awaited<ReturnType<typeof setup>>["connect"]) {
  const account = await connect(`hostId=${ACCOUNT_HOST}&installationId=${INSTALLATION}`, ACCESS_TOKEN);
  const mac = await connect(`hostId=${MAC_HOST}`, MAC_TOKEN);
  if (!(account instanceof WebSocket) || !(mac instanceof WebSocket))
    throw new Error("hosts did not connect");
  return { account: serve(account), mac: serve(mac) };
}

describe("retired hosted routes", () => {
  it("reach neither a signed-in Mac nor a legacy one", async () => {
    const { origin, connect } = await setup();
    const seen = await connectBoth(connect);
    for (const hostId of [ACCOUNT_HOST, MAC_HOST]) {
      for (const [path, status] of RETIRED_POST_ROUTES) {
        const answer = await fetch(`${origin}/h/${hostId}${path}`, { method: "POST", body: "{}" });
        expect(answer.status, `${hostId}${path}`).toBe(status);
      }
      expect((await fetch(`${origin}/h/${hostId}/v1/hosted/credits`)).status).toBe(404);
    }
    expect(seen.account).toEqual([]);
    expect(seen.mac).toEqual([]);
  });

  it("leave every other plaintext route behind encryption", async () => {
    const { origin, connect } = await setup();
    const seen = await connectBoth(connect);
    for (const hostId of [ACCOUNT_HOST, MAC_HOST]) {
      for (const path of ["/v1/pairing/complete", "/v1/gateway/push-authorize"]) {
        const refused = await fetch(`${origin}/h/${hostId}${path}`, { method: "POST", body: "{}" });
        expect(refused.status).toBe(426);
        expect(await refused.json()).toEqual({ error: "encryption_required" });
      }
    }
    expect(seen.account).toEqual([]);
    expect(seen.mac).toEqual([]);
  });

  it("refuse a host connection with anything but an account token or a legacy host token", async () => {
    const { connect } = await setup();
    // Shaped like the fleet-signed credential hosted bodies used to present.
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const fleetShaped = [
      part({ alg: "EdDSA", typ: "clankie-host", kid: "A".repeat(16) }),
      part({ accountId: ACCOUNT, installationId: INSTALLATION, hostId: ACCOUNT_HOST }),
      Buffer.alloc(64).toString("base64url"),
    ].join(".");
    expect(await connect(`hostId=${ACCOUNT_HOST}&installationId=${INSTALLATION}`, fleetShaped)).toBe(401);
    expect(await connect(`hostId=${MAC_HOST}`, fleetShaped)).toBe(401);
    expect(await connect(`hostId=${MAC_HOST}&installationId=${INSTALLATION}`, MAC_TOKEN)).toBe(401);
    expect(
      await connect(`hostId=${ACCOUNT_HOST}&installationId=${INSTALLATION}`, ACCESS_TOKEN),
    ).toBeInstanceOf(WebSocket);
    expect(await connect(`hostId=${MAC_HOST}`, MAC_TOKEN)).toBeInstanceOf(WebSocket);
  });
});

describe("the gateway process", () => {
  it("refuses to start with settings for the retired fleet", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", "tsx", "src/index.ts"],
        {
          cwd: GATEWAY_ROOT,
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            PORT: "65000",
            CLANKIE_GATEWAY_HOST: "127.0.0.1",
            CLANKIE_GATEWAY_HOST_TOKENS_JSON: JSON.stringify({ [MAC_HOST]: MAC_TOKEN }),
            CLANKIE_GATEWAY_FLEET_WAKE_URL: "http://clankie-fleet:8091/internal/v1/wake",
          },
        },
        (error, _stdout, stderr) =>
          resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stderr }),
      );
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Hosted fleet support was removed from the gateway; unset CLANKIE_GATEWAY_FLEET_WAKE_URL",
    );
  }, 40_000);
});
