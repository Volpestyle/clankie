import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "@clankie/protocol";
import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetRoomJournal } from "../src/captain/fleet-room.ts";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import type { HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { createKeyPresser, createPromptAnswerer } from "../src/captain/prompt-answer.ts";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { inspectConnectorRefreshRevocations } from "../../tui/src/command/doctor.ts";
import { runConnectorCommand } from "../../tui/src/command/connector.ts";
import { requestPairingOffer } from "../../tui/bin/pairing-offer.ts";
import { createQaService } from "./fixtures/qa-service.ts";
import { fakeRex } from "./fixtures/fake-rex.ts";
import { createRex } from "../src/captain/rex.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";

// The Claude connector's sign-in (ADR 0301) over real HTTP and durable device
// state: Claude registers, the owner approves the code with `clankie connector`,
// the code becomes a connector device whose tokens rotate and die with it.

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function cli(host: Awaited<ReturnType<typeof createQaService>>) {
  let stdout = "";
  let stderr = "";
  return {
    output: () => ({ stdout, stderr }),
    run: (args: readonly string[]) =>
      runConnectorCommand(args, {
        host: host.baseUrl,
        env: { ...process.env, CLANKIE_OPERATOR_TOKEN: host.operatorToken },
        stdout: { write: (text: string) => void (stdout += text) },
        stderr: { write: (text: string) => void (stderr += text) },
      }),
  };
}

async function register(
  baseUrl: string,
  redirectUris: readonly string[] = [CALLBACK],
  clientName = "Claude",
) {
  return fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris }),
  });
}

async function startSignIn(baseUrl: string, clientId: string, redirectUri = CALLBACK) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state",
    scope: "agents offline_access",
  });
  const page = await fetch(`${baseUrl}/oauth/authorize?${query}`);
  const html = await page.text();
  return {
    page,
    html,
    verifier,
    code: /class="code">([A-Z0-9-]+)</u.exec(html)?.[1],
    request: /const id="([^"]+)"/u.exec(html)?.[1],
  };
}

async function status(baseUrl: string, request: string) {
  const response = await fetch(`${baseUrl}/oauth/authorize/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request }),
  });
  return (await response.json()) as { status: string; redirect?: string };
}

async function token(baseUrl: string, form: Record<string, string>) {
  return fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

it("pairs a connector device on the owner's approval and keeps it to its own narrow door", async () => {
  const notices: string[] = [];
  const invalidated: string[] = [];
  const host = await createQaService({
    captain: {
      notifyRuntimeHealthAlert: async (text) => {
        notices.push(text);
        return true;
      },
      invalidateQuestionPrincipal: (deviceId) => {
        invalidated.push(deviceId);
      },
    },
  });
  try {
    const metadata = (await (
      await fetch(`${host.baseUrl}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: host.baseUrl,
      authorization_endpoint: `${host.baseUrl}/oauth/authorize`,
      token_endpoint: `${host.baseUrl}/oauth/token`,
      registration_endpoint: `${host.baseUrl}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });

    // A code goes only to an app's own https callback or a loopback address.
    for (const refused of [
      "http://grok.example/callback",
      "https://user:pass@grok.example/callback",
      "https://grok.example/callback#frag",
      "https://203.0.113.9/callback",
      "javascript:alert(1)",
    ])
      expect((await register(host.baseUrl, [refused])).status, refused).toBe(400);
    // Another hosted MCP app (Grok) signs in the same way, and the owner sees where access goes.
    const other = await register(host.baseUrl, ["https://grok.example/oauth/callback"]);
    expect(other.status).toBe(201);
    const otherSignIn = await startSignIn(
      host.baseUrl,
      ((await other.json()) as { client_id: string }).client_id,
      "https://grok.example/oauth/callback",
    );
    expect(otherSignIn.page.status).toBe(200);
    expect(otherSignIn.html).toContain("Approving sends access to grok.example.");
    const registered = await register(host.baseUrl, [CALLBACK, "http://localhost:33418/callback"]);
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    // An unregistered redirect never leaves this page, and a forged client id is refused.
    expect((await startSignIn(host.baseUrl, clientId, "https://claude.ai/elsewhere")).page.status).toBe(400);
    expect((await startSignIn(host.baseUrl, `${clientId}x`)).page.status).toBe(400);

    const signIn = await startSignIn(host.baseUrl, clientId);
    expect(signIn.page.status).toBe(200);
    expect(signIn.page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(signIn.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    // The command to run is copyable, and both color schemes set the code's own text color.
    expect(signIn.html).toContain(
      `<code id="command">clankie connector approve ${signIn.code}</code><button id="copy"`,
    );
    expect(signIn.html).toContain("prefers-color-scheme:dark");
    expect(await status(host.baseUrl, signIn.request!)).toEqual({ status: "pending" });

    const owner = cli(host);
    expect(await owner.run(["--json"])).toBe(0);
    expect(JSON.parse(owner.output().stdout)).toMatchObject({
      ok: true,
      signIns: expect.arrayContaining([
        expect.objectContaining({ code: signIn.code, clientName: "Claude", redirectHost: "claude.ai" }),
        expect.objectContaining({ code: otherSignIn.code, redirectHost: "grok.example" }),
      ]),
    });
    // Nobody but the owner sees or decides a sign-in.
    expect((await fetch(`${host.baseUrl}/v1/connector/sign-ins`)).status).toBe(401);
    expect(await owner.run(["approve", signIn.code!.toLowerCase()])).toBe(0);
    expect(owner.output().stdout).toContain(`Approved ${signIn.code}`);
    expect(await owner.run(["deny", signIn.code!])).toBe(1);
    expect(owner.output().stderr).toContain("already approved or denied");

    const approved = await status(host.baseUrl, signIn.request!);
    expect(approved.status).toBe("approved");
    const callback = new URL(approved.redirect!);
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK);
    expect(callback.searchParams.get("state")).toBe("claude-state");
    const code = callback.searchParams.get("code")!;

    // The code needs the sign-in's own PKCE verifier and is good once.
    const wrongVerifier = await token(host.baseUrl, {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code,
      code_verifier: randomBytes(32).toString("base64url"),
    });
    expect(await wrongVerifier.json()).toEqual({ error: "invalid_grant" });

    const second = await startSignIn(host.baseUrl, clientId);
    expect(await owner.run(["approve", second.code!])).toBe(0);
    const secondCode = new URL((await status(host.baseUrl, second.request!)).redirect!).searchParams.get(
      "code",
    )!;
    const exchange = {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code: secondCode,
      code_verifier: second.verifier,
    };
    const issued = await token(host.baseUrl, exchange);
    expect(issued.status).toBe(200);
    const tokens = (await issued.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(tokens.expires_in).toBe(3600);
    expect((await token(host.baseUrl, exchange)).status).toBe(400);

    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    const self = (await (await fetch(`${host.baseUrl}/v1/devices/self`, { headers: bearer })).json()) as {
      deviceId: string;
      scope?: string;
      grants: Record<string, boolean>;
    };
    expect(self).toMatchObject({
      scope: "connector",
      grants: { chat: true, steer: true, terminalObserve: true, terminalControl: false },
    });
    // A connector reaches nothing else here: not refresh, settings, or other sign-ins.
    for (const [method, path] of [
      ["POST", "/v1/devices/self/session/refresh"],
      ["GET", "/v1/devices"],
      ["GET", "/v1/connector/sign-ins"],
      ["GET", "/v1/operator/http-settings"],
    ] as const)
      expect(
        (await fetch(`${host.baseUrl}${path}`, { method, headers: bearer })).status,
      ).toBeGreaterThanOrEqual(401);

    // Refresh works, survives replay, then the newer token rotates again.
    host.advance(60_000);
    const refreshed = await token(host.baseUrl, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    await host.restart();
    host.advance(1);
    const afterRestart = await token(host.baseUrl, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: rotated.refresh_token,
    });
    expect(afterRestart.status).toBe(200);
    const latest = (await afterRestart.json()) as { access_token: string; refresh_token: string };
    expect(latest.refresh_token).not.toBe(rotated.refresh_token);

    // Even stale tokens with an invalid MAC or the wrong client do not revoke.
    const { client_id: otherClient } = (await (
      await register(host.baseUrl, ["https://grok.example/oauth/callback"], "Grok")
    ).json()) as { client_id: string };
    for (const form of [
      { client_id: clientId, refresh_token: `${tokens.refresh_token}x` },
      { client_id: otherClient, refresh_token: tokens.refresh_token },
      { client_id: clientId, refresh_token: "not-a-refresh-token" },
    ]) {
      expect(await (await token(host.baseUrl, { grant_type: "refresh_token", ...form })).json()).toEqual({
        error: "invalid_grant",
      });
    }
    expect(notices).toEqual([]);
    expect(invalidated).toEqual([]);

    expect(
      (
        await fetch(`${host.baseUrl}/v1/devices/self`, {
          headers: { authorization: `Bearer ${latest.access_token}` },
        })
      ).status,
    ).toBe(200);

    // The immediately previous binding survives replay and concurrent-session retries.
    await host.restart();
    const reuse = { grant_type: "refresh_token", client_id: clientId, refresh_token: rotated.refresh_token };
    host.advance(59_999);
    expect(await (await token(host.baseUrl, reuse)).json()).toEqual({ error: "invalid_grant" });
    expect(
      (
        await fetch(`${host.baseUrl}/v1/devices/self`, {
          headers: { authorization: `Bearer ${latest.access_token}` },
        })
      ).status,
    ).toBe(200);
    expect(notices).toEqual([]);
    expect(invalidated).toEqual([]);

    // Exactly 60 seconds after the current binding, the same token revokes.
    host.advance(1);
    await host.restart();
    expect(await (await token(host.baseUrl, reuse)).json()).toEqual({ error: "invalid_grant" });
    expect(invalidated).toEqual([self.deviceId]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('connector app "Claude"');
    expect(notices[0]).toContain(`device "Claude" (${self.deviceId})`);
    // The owner apps' device list and doctor's existing operator client see the revocation.
    const doctor = await inspectConnectorRefreshRevocations({
      repoRoot: resolve(import.meta.dirname, "../../.."),
      host: host.baseUrl,
      env: { ...process.env, CLANKIE_OPERATOR_TOKEN: host.operatorToken },
    });
    expect(doctor).toMatchObject({
      devices: [
        {
          deviceId: self.deviceId,
          name: "Claude",
          status: "revoked",
          revokedBy: "connector-refresh-reuse",
        },
      ],
    });
    const events = (await readFile(host.eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    expect(events.filter((event) => event.type === "device.revoked")).toMatchObject([
      {
        data: {
          deviceId: self.deviceId,
          deviceName: "Claude",
          appName: "Claude",
          revokedBy: "connector-refresh-reuse",
        },
      },
    ]);

    // Replay preserves revocation: every access token and the newest refresh token fail.
    await host.restart();
    for (const accessToken of [tokens.access_token, rotated.access_token, latest.access_token]) {
      expect(
        (
          await fetch(`${host.baseUrl}/v1/devices/self`, {
            headers: { authorization: `Bearer ${accessToken}` },
          })
        ).status,
      ).toBe(401);
    }
    for (const refreshToken of [tokens.refresh_token, rotated.refresh_token, latest.refresh_token]) {
      expect(
        await (
          await token(host.baseUrl, {
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: refreshToken,
          })
        ).json(),
      ).toEqual({ error: "invalid_grant" });
    }
    expect(notices).toHaveLength(1);
    expect(invalidated).toEqual([self.deviceId]);
    expect(
      await inspectConnectorRefreshRevocations({
        repoRoot: resolve(import.meta.dirname, "../../.."),
        host: host.baseUrl,
        env: { ...process.env, CLANKIE_OPERATOR_TOKEN: host.operatorToken },
      }),
    ).toEqual(doctor);

    // A denied sign-in sends Claude back with access_denied and pairs nothing.
    const denied = await startSignIn(host.baseUrl, clientId);
    expect(await owner.run(["deny", denied.code!])).toBe(0);
    const deniedStatus = await status(host.baseUrl, denied.request!);
    expect(deniedStatus.status).toBe("denied");
    expect(new URL(deniedStatus.redirect!).searchParams.get("error")).toBe("access_denied");
  } finally {
    await host.close();
  }
}, 30_000);

it("revokes immediately for a token two rotations old, across restart", async () => {
  const host = await createQaService();
  try {
    const { client_id: clientId } = (await (await register(host.baseUrl)).json()) as { client_id: string };
    const signIn = await startSignIn(host.baseUrl, clientId);
    expect(await cli(host).run(["approve", signIn.code!])).toBe(0);
    const code = new URL((await status(host.baseUrl, signIn.request!)).redirect!).searchParams.get("code")!;
    const initial = (await (
      await token(host.baseUrl, {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code,
        code_verifier: signIn.verifier,
      })
    ).json()) as { access_token: string; refresh_token: string };
    const refresh = (refreshToken: string) =>
      token(host.baseUrl, {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      });
    host.advance(1);
    const concurrent = await Promise.all([refresh(initial.refresh_token), refresh(initial.refresh_token)]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 400]);
    const rotated = (await concurrent.find((response) => response.status === 200)!.json()) as {
      access_token: string;
      refresh_token: string;
    };
    await host.restart();
    // The initial activation is the previous binding after the very first refresh.
    expect(await (await refresh(initial.refresh_token)).json()).toEqual({ error: "invalid_grant" });
    expect(
      (
        await fetch(`${host.baseUrl}/v1/devices/self`, {
          headers: { authorization: `Bearer ${rotated.access_token}` },
        })
      ).status,
    ).toBe(200);
    host.advance(1);
    const second = await refresh(rotated.refresh_token);
    expect(second.status).toBe(200);
    const latest = (await second.json()) as { access_token: string; refresh_token: string };
    await host.restart();
    // The oldest binding is two generations behind, within the current binding's 60s window.
    expect(await (await refresh(initial.refresh_token)).json()).toEqual({ error: "invalid_grant" });
    expect(
      (
        await fetch(`${host.baseUrl}/v1/devices/self`, {
          headers: { authorization: `Bearer ${latest.access_token}` },
        })
      ).status,
    ).toBe(401);
    expect(await (await refresh(latest.refresh_token)).json()).toEqual({ error: "invalid_grant" });
  } finally {
    await host.close();
  }
});

it("a token from the owner's approval opens the relay's tools, and revoking the device closes them", async () => {
  const host = await createQaService();
  // The relay asks this service who each bearer is, as it does on the Mac.
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
    if (request.op === "terminal_catalog") return { op: "terminal_catalog", schemaVersion: 1, sessions: [] };
    throw new Error(`unexpected ${request.op}`);
  };
  let relayUrl = "";
  const operator = createOperatorConversationRelayHandler({ authorizeDevice, dispatch });
  const connector = createConnectorMcpHandler({
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
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  try {
    // Claude's discovery: the relay's resource names this service as its sign-in.
    const challenge = await fetch(`${relayUrl}/mcp`, { method: "POST" });
    expect(challenge.status).toBe(401);
    const resource = (await (await fetch(`${relayUrl}/.well-known/oauth-protected-resource/mcp`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resource).toMatchObject({ resource: `${relayUrl}/mcp`, authorization_servers: [host.baseUrl] });

    const { client_id: clientId } = (await (await register(host.baseUrl)).json()) as { client_id: string };
    const signIn = await startSignIn(host.baseUrl, clientId);
    expect(await cli(host).run(["approve", signIn.code!])).toBe(0);
    const code = new URL((await status(host.baseUrl, signIn.request!)).redirect!).searchParams.get("code")!;
    const tokens = (await (
      await token(host.baseUrl, {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code,
        code_verifier: signIn.verifier,
      })
    ).json()) as { access_token: string };

    const client = new Client({ name: "connector-e2e", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }) as unknown as Transport,
    );
    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(JSON.parse((listed.content as Array<{ text: string }>)[0]!.text)).toEqual({
      agents: [],
      machines: [],
    });
    await client.close();

    const self = (await (
      await fetch(`${host.baseUrl}/v1/devices/self`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
    ).json()) as { deviceId: string };
    expect((await host.operator(`/v1/devices/${self.deviceId}/revoke`)).status).toBe(200);
    const revoked = await fetch(`${relayUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain('error="invalid_token"');
  } finally {
    relay.closeAllConnections();
    relay.close();
    await host.close();
  }
}, 30_000);

it("lets the owner's durable app approve sign-ins, never an automation run's device", async () => {
  const host = await createQaService();
  host.advance(Date.now() - host.now());
  try {
    const pair = async (run?: NonNullable<NonNullable<Parameters<typeof requestPairingOffer>[0]>["run"]>) => {
      const offer = await requestPairingOffer({
        controlPlaneUrl: host.baseUrl,
        operatorToken: host.operatorToken,
        ...(run === undefined ? {} : { run }),
      });
      const post = async (path: string, body: unknown) =>
        (await (
          await fetch(`${host.baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).json()) as Record<string, unknown>;
      const pending = await post("/v1/pairing/redeem", {
        code: offer.localCode ?? offer.code,
        device: { name: "Phone", platform: "ios" },
      });
      const paired = await post("/v1/pairing/complete", {
        completionToken: pending.completionToken,
        acceptedGrants: pending.offeredGrants,
      });
      expect(pending.offeredGrants).toMatchObject({ terminalControl: true });
      return { authorization: `Bearer ${String(paired.deviceToken)}` };
    };
    const app = await pair();
    expect((await fetch(`${host.baseUrl}/v1/connector/sign-ins`, { headers: app })).status).toBe(200);
    // Its access would end with the run; a connector it approved would not.
    const automation = await pair({ runId: "capture", purpose: "simulator", ttlSeconds: 900 });
    expect((await fetch(`${host.baseUrl}/v1/connector/sign-ins`, { headers: automation })).status).toBe(403);
  } finally {
    await host.close();
  }
});

it("an app's note reaches the real board signed with the name the owner approved, and the phone's room leaves it out", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "connector-board-"));
  const board = new FleetRoomJournal(boardRoot);
  const captainToken = randomBytes(24).toString("hex");
  // The captain's own wiring of the board, over the fleet room's journal.
  const host = await createQaService({
    captainToken,
    captain: {
      fleetRoom: (request, signal) => board.read(request, signal),
      appNotes: async (command) =>
        command.action === "post"
          ? board.postAppNote(command.author, command.text)
          : board.readAppNotes(command),
    },
  });
  const authorizeDevice = new ControlPlaneDeviceAuthorizer({ baseUrl: host.baseUrl });
  let relayUrl = "";
  // The production hop: the relay dispatches on its own captain bearer.
  const operator = createOperatorConversationRelayHandler({
    authorizeDevice,
    dispatch: createCaptainConversationDispatch({ baseUrl: host.baseUrl, bearerToken: captainToken }),
  });
  const connector = createConnectorMcpHandler({
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
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  try {
    const signIn = async (name: string, callback: string) => {
      const { client_id: clientId } = (await (await register(host.baseUrl, [callback], name)).json()) as {
        client_id: string;
      };
      const started = await startSignIn(host.baseUrl, clientId, callback);
      expect(await cli(host).run(["approve", started.code!])).toBe(0);
      const code = new URL((await status(host.baseUrl, started.request!)).redirect!).searchParams.get(
        "code",
      )!;
      const { access_token: accessToken } = (await (
        await token(host.baseUrl, {
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: callback,
          code,
          code_verifier: started.verifier,
        })
      ).json()) as { access_token: string };
      const client = new Client({ name: `${name}-e2e`, version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
          requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
        }) as unknown as Transport,
      );
      clients.push(client);
      const self = (await (
        await fetch(`${host.baseUrl}/v1/devices/self`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).json()) as { deviceId: string };
      return { client, deviceId: self.deviceId };
    };
    const claude = await signIn("Claude", CALLBACK);
    const grok = await signIn("Grok", "https://grok.example/oauth/callback");
    const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      (result.content as Array<{ text: string }>)[0]!.text;

    const note = "Claude here: I'm reviewing the kh2 netcode PR; Bram's pane is mine until 5pm.";
    // An author argument is no part of the tool: it is refused, and the board signs with the approved name.
    const forged = await claude.client.callTool({
      name: "post_note",
      arguments: { text: note, author: "Owner" },
    });
    expect(forged.isError).toBe(true);
    expect(textOf(forged)).toContain('Unknown arguments for post_note: "author"');
    const posted = await claude.client.callTool({ name: "post_note", arguments: { text: note } });
    expect(JSON.parse(textOf(posted)).posted).toMatchObject({ author: "Claude", text: note });
    const read = JSON.parse(textOf(await grok.client.callTool({ name: "read_notes", arguments: {} }))) as {
      notes: Array<{ author: string; text: string }>;
      newer: string;
    };
    expect(read.notes).toEqual([
      { sequence: 1, at: expect.any(String), author: "Claude", authorKind: "app", text: note },
    ]);
    // A note is scrubbed like every other room entry.
    await grok.client.callTool({
      name: "post_note",
      arguments: { text: "Grok: took the docs. My scratch key was api_key=sk-live-1234567890abcdef" },
    });
    const after = JSON.parse(
      textOf(await claude.client.callTool({ name: "read_notes", arguments: { since: read.newer } })),
    ) as { notes: Array<{ author: string; text: string }> };
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0]!.author).toBe("Grok");
    expect(after.notes[0]!.text).not.toContain("sk-live-1234567890abcdef");

    const dispatch = (bearer: string, body: unknown) =>
      fetch(`${host.baseUrl}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const room = async (include?: readonly string[]) => {
      const response = await dispatch(host.operatorToken, {
        op: "fleet_room",
        schemaVersion: 1,
        ...(include === undefined ? {} : { include }),
      });
      expect(response.status).toBe(200);
      return (
        (await response.json()) as {
          result: { entries: Array<{ kind: string; from: unknown; text: string }> };
        }
      ).result.entries;
    };
    // What the owner's phone asks for today: no app notes, so its older strict parser keeps working.
    expect(await room()).toEqual([]);
    const notes = await room(["app_note"]);
    expect(notes.map((entry) => [entry.kind, entry.from])).toEqual([
      ["app_note", { kind: "app", label: "Claude" }],
      ["app_note", { kind: "app", label: "Grok" }],
    ]);
    // Scrubbed in the journal itself, not only on the relay's way out.
    expect(notes[1]!.text).not.toContain("sk-live-1234567890abcdef");

    // Only the relay's bearer stamps an author, and only a live connector device's.
    const stamped = { op: "app_notes", schemaVersion: 1, action: "post", text: "forged" };
    expect((await dispatch(host.operatorToken, { ...stamped, appDeviceId: claude.deviceId })).status).toBe(
      403,
    );
    expect((await dispatch(captainToken, stamped)).status).toBe(403);
    expect((await dispatch(captainToken, { ...stamped, appDeviceId: "not-a-device" })).status).toBe(403);
    expect((await host.operator(`/v1/devices/${claude.deviceId}/revoke`)).status).toBe(200);
    expect((await dispatch(captainToken, { ...stamped, appDeviceId: claude.deviceId })).status).toBe(403);
    // The owner reads the board itself.
    const owned = await dispatch(host.operatorToken, { op: "app_notes", schemaVersion: 1, action: "read" });
    expect(((await owned.json()) as { result: { notes: unknown[] } }).result.notes).toHaveLength(2);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    relay.closeAllConnections();
    relay.close();
    await host.close();
    await rm(boardRoot, { recursive: true, force: true });
  }
}, 30_000);

it("an app answers an agent's prompt only once the owner turns it on, only while it shows, and once", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "connector-prompts-"));
  const board = new FleetRoomJournal(boardRoot);
  const captainToken = randomBytes(24).toString("hex");
  // Herdr's side of the panes on a linked PC, reached through Clankie's real fleet
  // router. Bram waits on a Claude Code permission prompt, Ivy's menu redraws the same
  // after a key, Clankie already sent Pip's question to the owner; Kai, Rex, Zed and
  // Ada each change mid-answer.
  const permission = [
    "Bash command",
    "  git push origin main",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. Yes, and don't ask again for git push commands",
    "  3. No, and tell Claude what to do differently (esc)",
  ].join("\n");
  const panes = new Map<string, { status: string; screen: string; paneId?: string }>([
    ["term-bram", { status: "blocked", screen: permission }],
    ["term-ivy", { status: "blocked", screen: "Pick a layout\n❯ 1. Grid\n  2. Stack\n  3. Type something" }],
    ["term-pip", { status: "blocked", screen: "Which branch?\n❯ 1. main\n  2. dev" }],
    ["term-kai", { status: "blocked", screen: "Allow this edit?\n❯ 1. Yes\n  2. No" }],
    ["term-rex", { status: "blocked", screen: "Run the migration?\n❯ 1. Yes\n  2. No" }],
    ["term-zed", { status: "blocked", screen: "Pick a theme\n❯ 1. Dark\n  2. Light" }],
    ["term-ada", { status: "blocked", screen: "Delete the branch?\n❯ 1. Yes\n  2. No" }],
  ]);
  const paneOf = (id: string) => panes.get(id)!.paneId ?? `p-${id}`;
  const sent: string[][] = [];
  let revoke = async () => undefined as unknown;
  // What each pane does once a key reaches it.
  const reactions: Record<string, () => Promise<unknown>> = {
    // Bram and Kai go to work on their answers.
    "p-term-bram": async () => panes.set("term-bram", { status: "working", screen: "⏺ Bash(git push)" }),
    "p-term-kai": async () => panes.set("term-kai", { status: "working", screen: "⏺ Update(app.ts)" }),
    // The owner turns answering off for Claude while Rex's answer is under way.
    "p-term-rex": () => revoke(),
    // Zed's terminal moves to another pane.
    "p-term-zed": async () => panes.set("term-zed", { ...panes.get("term-zed")!, paneId: "p-term-zed-2" }),
    // The PC's connection changes to a new endpoint.
    "p-term-ada": async () => void (endpoint = "pc-b"),
  };
  // Each connection refuses calls once the PC's connection changed, as Clankie's fleet
  // runners do; only what binding a pane uses is here.
  let endpoint = "pc-a";
  const connection = (name: string) => {
    const live = () => {
      if (endpoint !== name) throw new Error("Machine connection pc changed or disconnected");
    };
    const after = async (paneId: string) => reactions[paneId]?.();
    return {
      resolveTerminal: async (id: string) => {
        live();
        const pane = panes.get(id);
        return pane === undefined
          ? undefined
          : { paneId: paneOf(id), terminalId: id, name: id, agent: "claude", status: pane.status, title: id };
      },
      readPane: async (paneId: string) => {
        live();
        return [...panes.keys()].map((id) => (paneOf(id) === paneId ? panes.get(id)!.screen : "")).join("");
      },
      sendKeys: async (paneId: string, keys: readonly string[]) => {
        live();
        sent.push(["keys", name, paneId, ...keys]);
        await after(paneId);
      },
      sendText: async (paneId: string, text: string) => {
        live();
        sent.push(["text", name, paneId, text]);
        await after(paneId);
      },
    } as unknown as HerdrWatchRunner;
  };
  const connections = new Map([
    ["pc-a", connection("pc-a")],
    ["pc-b", connection("pc-b")],
  ]);
  const answerPrompt = createPromptAnswerer({
    paneAddress: async (terminalId) => (panes.has(terminalId) ? `pc/${terminalId}` : undefined),
    runner: routeHerdrFleets(
      {} as HerdrWatchRunner,
      async () => new Map([["pc", connections.get(endpoint)!]]),
    ),
    ownerAskPending: (seatId) => seatId === "pc/term-pip",
    record: (app, text) => board.postAppNote(app, text),
  });
  const host = await createQaService({
    captainToken,
    captain: {
      answerPrompt,
      appNotes: async (command) =>
        command.action === "post"
          ? board.postAppNote(command.author, command.text)
          : board.readAppNotes(command),
    },
  });
  const authorizeDevice = new ControlPlaneDeviceAuthorizer({ baseUrl: host.baseUrl });
  let relayUrl = "";
  const operator = createOperatorConversationRelayHandler({
    authorizeDevice,
    dispatch: createCaptainConversationDispatch({ baseUrl: host.baseUrl, bearerToken: captainToken }),
  });
  const connector = createConnectorMcpHandler({
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
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  try {
    const signIn = async (name: string, callback: string) => {
      const { client_id: clientId } = (await (await register(host.baseUrl, [callback], name)).json()) as {
        client_id: string;
      };
      const started = await startSignIn(host.baseUrl, clientId, callback);
      expect(await cli(host).run(["approve", started.code!])).toBe(0);
      const code = new URL((await status(host.baseUrl, started.request!)).redirect!).searchParams.get(
        "code",
      )!;
      const { access_token: accessToken } = (await (
        await token(host.baseUrl, {
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: callback,
          code,
          code_verifier: started.verifier,
        })
      ).json()) as { access_token: string };
      const client = new Client({ name: `${name}-e2e`, version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
          requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
        }) as unknown as Transport,
      );
      clients.push(client);
      const self = (await (
        await fetch(`${host.baseUrl}/v1/devices/self`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).json()) as { deviceId: string };
      return { client, deviceId: self.deviceId, accessToken };
    };
    const claude = await signIn("Claude", CALLBACK);
    const grok = await signIn("Grok", "https://grok.example/oauth/callback");
    const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      (result.content as Array<{ text: string }>)[0]!.text;
    const answer = (client: Client, agent: string, expected: string, steps: unknown[]) =>
      client.callTool({ name: "answer_prompt", arguments: { agent, expect: expected, steps } });

    // Off for every app until the owner turns it on at the Mac.
    const off = await answer(claude.client, "herdr:term-bram", "1. Yes", [{ text: "1" }]);
    expect(off.isError).toBe(true);
    expect(textOf(off)).toContain("hasn't turned on answering prompts for Claude");
    const owner = cli(host);
    expect(await owner.run(["prompts", "on", "Claude"])).toBe(0);
    expect(owner.output().stdout).toContain("Claude: on");
    expect(owner.output().stdout).toContain("Grok: off");
    revoke = () => owner.run(["prompts", "off", "Claude"]);
    expect(sent).toEqual([]);

    // The prompt must still show what the app saw.
    const changed = await answer(claude.client, "herdr:term-bram", "4. Always", [{ text: "4" }]);
    expect(textOf(changed)).toContain("isn't on that agent's screen now");
    const answered = await answer(claude.client, "herdr:term-bram", "1.   Yes", [{ text: "1" }]);
    expect(answered.isError).toBeFalsy();
    expect(JSON.parse(textOf(answered))).toMatchObject({ agent: "herdr:term-bram", status: "answered" });
    expect(sent).toEqual([["text", "pc-a", "p-term-bram", "1"]]);
    // Bram went to work: no prompt waits now.
    const working = await answer(claude.client, "herdr:term-bram", "Bash", [{ key: "enter" }]);
    expect(textOf(working)).toContain("isn't waiting on a prompt (it is working)");

    // A menu that looks the same afterwards is answered once.
    const typed = await answer(claude.client, "herdr:term-ivy", "3. Type something", [
      { text: "3" },
      { text: "Grid, but two columns" },
      { key: "enter" },
    ]);
    expect(typed.isError).toBeFalsy();
    const again = await answer(claude.client, "herdr:term-ivy", "3. Type something", [{ key: "enter" }]);
    expect(textOf(again)).toContain("already answered");
    expect(sent.slice(1)).toEqual([
      ["text", "pc-a", "p-term-ivy", "3"],
      ["text", "pc-a", "p-term-ivy", "Grid, but two columns"],
      ["keys", "pc-a", "p-term-ivy", "enter"],
    ]);

    // A question Clankie sent to the owner stays the owner's; Grok was never turned on.
    expect(textOf(await answer(claude.client, "herdr:term-pip", "1. main", [{ text: "1" }]))).toContain(
      "the owner's to answer",
    );
    expect(textOf(await answer(grok.client, "herdr:term-pip", "1. main", [{ text: "1" }]))).toContain(
      "for Grok",
    );
    // Control characters and unnamed keys never reach a pane.
    const raw = await answer(claude.client, "herdr:term-pip", "1. main", [{ text: "1\r\u001b[A" }]);
    expect(raw.isError).toBe(true);
    expect((await answer(claude.client, "herdr:term-pip", "1. main", [{ key: "ctrl+c" }])).isError).toBe(
      true,
    );
    expect(sent).toHaveLength(4);

    // Each answer is on the note board, signed by the app that gave it.
    const notes = board.readAppNotes({ limit: 20 });
    expect(notes.outcome === "ready" && notes.notes.map((note) => [note.author, note.text])).toEqual([
      ["Claude", 'Answered a prompt in term-bram: typed "1".'],
      ["Claude", 'Answered a prompt in term-ivy: typed "3", typed "Grid, but two columns", enter.'],
    ]);

    // Every step waits again for the prompt, in the same pane over the same connection,
    // with answering still on: an answer stops part way rather than type into whatever
    // the pane shows next.
    const kai = await answer(claude.client, "herdr:term-kai", "Allow this edit?", [
      { text: "1" },
      { key: "enter" },
    ]);
    expect(kai.isError).toBe(true);
    expect(textOf(kai)).toContain("Stopped after 1 of 2 steps");
    expect(textOf(kai)).toContain("the agent stopped waiting on the prompt");
    const zed = await answer(claude.client, "herdr:term-zed", "Pick a theme", [
      { key: "down" },
      { key: "enter" },
    ]);
    expect(textOf(zed)).toContain("the agent's pane went away");
    const ada = await answer(claude.client, "herdr:term-ada", "Delete the branch?", [
      { key: "down" },
      { key: "enter" },
    ]);
    expect(textOf(ada)).toContain("Only part of the answer may have reached the agent");
    const rex = await answer(claude.client, "herdr:term-rex", "Run the migration?", [
      { key: "down" },
      { key: "enter" },
    ]);
    expect(textOf(rex)).toContain("answering was turned off for this app");
    // Ada's enter never went to the PC's new endpoint; a new answer binds to it afresh.
    expect(sent.slice(4)).toEqual([
      ["text", "pc-a", "p-term-kai", "1"],
      ["keys", "pc-a", "p-term-zed", "down"],
      ["keys", "pc-a", "p-term-ada", "down"],
      ["keys", "pc-b", "p-term-rex", "down"],
    ]);
    const parts = board.readAppNotes({ limit: 20 });
    expect(parts.outcome === "ready" && parts.notes.slice(2).map((note) => note.text)).toEqual([
      'Answered part of a prompt in term-kai: typed "1"; stopped because the agent stopped waiting on the prompt.',
      "Answered part of a prompt in term-zed: down; stopped because the agent's pane went away.",
      "Answered part of a prompt in term-ada: down; stopped because Clankie lost the pane or its machine.",
      "Answered part of a prompt in term-rex: down; stopped because answering was turned off for this app.",
    ]);

    // By hand: the relay stamps the app, and the service takes the stamp only on the relay's bearer.
    const prompt = {
      op: "prompt_answer",
      schemaVersion: 1,
      terminalId: "term-pip",
      expect: "1. main",
      steps: [{ text: "1" }],
    };
    const forged = await fetch(new URL("/operator/v1/dispatch", relayUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${grok.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...prompt, appDeviceId: claude.deviceId }),
    });
    expect(forged.status).toBe(400);
    const direct = (bearer: string, body: unknown) =>
      fetch(`${host.baseUrl}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await direct(host.operatorToken, { ...prompt, appDeviceId: claude.deviceId })).status).toBe(403);
    expect((await direct(captainToken, prompt)).status).toBe(403);

    // Turning it off, or revoking the app, stops it at once.
    expect(await owner.run(["prompts", "off", claude.deviceId])).toBe(0);
    panes.set("term-bram", { status: "blocked", screen: permission });
    expect(textOf(await answer(claude.client, "herdr:term-bram", "1. Yes", [{ text: "1" }]))).toContain(
      "hasn't turned on",
    );
    expect(sent).toHaveLength(8);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    relay.closeAllConnections();
    relay.close();
    await host.close();
    await rm(boardRoot, { recursive: true, force: true });
  }
}, 30_000);

it("an app presses keys in an agent's terminal only once the owner turns it on, on every machine and in the desktop app", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "connector-keys-"));
  const board = new FleetRoomJournal(boardRoot);
  const captainToken = randomBytes(24).toString("hex");
  // Bram works on a linked PC and Ivy sits in a picker there; Pip's question went to the
  // owner; Kai's terminal moves mid-press. Dot is a hire in the desktop app, which takes
  // named keys only.
  const panes = new Map<string, { status: string; paneId?: string }>([
    ["term-bram", { status: "working" }],
    ["term-ivy", { status: "idle" }],
    ["term-pip", { status: "blocked" }],
    ["term-kai", { status: "working" }],
  ]);
  const paneOf = (id: string) => panes.get(id)!.paneId ?? `p-${id}`;
  const sent: string[][] = [];
  const pc = {
    resolveTerminal: async (id: string) => {
      const pane = panes.get(id);
      return pane === undefined
        ? undefined
        : { paneId: paneOf(id), terminalId: id, name: id, agent: "claude", status: pane.status, title: id };
    },
    readPane: async () => "",
    sendKeys: async (paneId: string, keys: readonly string[]) => {
      sent.push(["pc", paneId, ...keys]);
      if (paneId === "p-term-kai") panes.set("term-kai", { status: "working", paneId: "p-term-kai-2" });
    },
    sendText: async (paneId: string, text: string) => void sent.push(["pc-text", paneId, text]),
  } as unknown as HerdrWatchRunner;
  const desktop = {
    resolveTerminal: async (id: string) =>
      id === "t4"
        ? { paneId: "t4", terminalId: "t4", name: "dot", agent: "claude", status: "blocked", title: "dot" }
        : undefined,
    readPane: async () => "Allow this edit?\n❯ 1. Yes\n  2. No",
    sendKeys: async (paneId: string, keys: readonly string[]) => void sent.push(["desktop", paneId, ...keys]),
  } as unknown as HerdrWatchRunner;
  const deps = {
    paneAddress: async (terminalId: string) =>
      terminalId === "dot" ? "herdr-core/t4" : panes.has(terminalId) ? `pc/${terminalId}` : undefined,
    runner: routeHerdrFleets(
      {} as HerdrWatchRunner,
      new Map([
        ["pc", pc],
        ["herdr-core", desktop],
      ]),
    ),
    ownerAskPending: (seatId: string) => seatId === "pc/term-pip",
    record: (app: string, text: string) => board.postAppNote(app, text),
  };
  const host = await createQaService({
    captainToken,
    captain: {
      pressKeys: createKeyPresser(deps),
      answerPrompt: createPromptAnswerer(deps),
      appNotes: async (command) =>
        command.action === "post"
          ? board.postAppNote(command.author, command.text)
          : board.readAppNotes(command),
    },
  });
  const authorizeDevice = new ControlPlaneDeviceAuthorizer({ baseUrl: host.baseUrl });
  let relayUrl = "";
  const operator = createOperatorConversationRelayHandler({
    authorizeDevice,
    dispatch: createCaptainConversationDispatch({ baseUrl: host.baseUrl, bearerToken: captainToken }),
  });
  const connector = createConnectorMcpHandler({
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
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  try {
    const signIn = async (name: string, callback: string) => {
      const { client_id: clientId } = (await (await register(host.baseUrl, [callback], name)).json()) as {
        client_id: string;
      };
      const started = await startSignIn(host.baseUrl, clientId, callback);
      expect(await cli(host).run(["approve", started.code!])).toBe(0);
      const code = new URL((await status(host.baseUrl, started.request!)).redirect!).searchParams.get(
        "code",
      )!;
      const { access_token: accessToken } = (await (
        await token(host.baseUrl, {
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: callback,
          code,
          code_verifier: started.verifier,
        })
      ).json()) as { access_token: string };
      const client = new Client({ name: `${name}-e2e`, version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
          requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
        }) as unknown as Transport,
      );
      clients.push(client);
      return { client, accessToken };
    };
    const claude = await signIn("Claude", CALLBACK);
    const grok = await signIn("Grok", "https://grok.example/oauth/callback");
    const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      (result.content as Array<{ text: string }>)[0]!.text;
    const press = (client: Client, agent: string, keys: unknown[]) =>
      client.callTool({ name: "press_keys", arguments: { agent, keys } });

    // Off until the owner turns it on, with the same switch as answering prompts.
    const off = await press(claude.client, "herdr:term-bram", ["ctrl+c"]);
    expect(off.isError).toBe(true);
    expect(textOf(off)).toContain("hasn't turned on prompts and keys for Claude");
    const owner = cli(host);
    expect(await owner.run(["prompts", "on", "Claude"])).toBe(0);
    expect(owner.output().stdout).toContain("press keys");

    // A working agent takes keys: an interrupt, and a picker walked with arrows.
    const stop = await press(claude.client, "herdr:term-bram", ["ctrl+c"]);
    expect(stop.isError).toBeFalsy();
    expect(JSON.parse(textOf(stop))).toMatchObject({ agent: "herdr:term-bram", status: "pressed" });
    expect(
      (await press(claude.client, "herdr:term-ivy", ["down", "down", "shift+tab", "enter"])).isError,
    ).toBeFalsy();
    // So does a hire in the desktop app, through its own core.
    expect((await press(claude.client, "herdr:dot", ["esc"])).isError).toBeFalsy();
    expect(sent).toEqual([
      ["pc", "p-term-bram", "ctrl+c"],
      ["pc", "p-term-ivy", "down"],
      ["pc", "p-term-ivy", "down"],
      ["pc", "p-term-ivy", "shift+tab"],
      ["pc", "p-term-ivy", "enter"],
      ["desktop", "t4", "esc"],
    ]);

    // Text, control characters and unknown keys never reach a terminal.
    for (const keys of [["hello"], ["\u001b[A"], ["ctrl+"], [], Array(25).fill("up")])
      expect((await press(claude.client, "herdr:term-bram", keys)).isError).toBe(true);
    // The desktop app takes no typed text, even at a prompt.
    const typed = await claude.client.callTool({
      name: "answer_prompt",
      arguments: { agent: "herdr:dot", expect: "Allow this edit?", steps: [{ text: "1" }] },
    });
    expect(textOf(typed)).toContain("only named keys");
    // A screen Clankie sent to the owner stays the owner's; Grok was never turned on.
    expect(textOf(await press(claude.client, "herdr:term-pip", ["enter"]))).toContain("owner's to answer");
    expect(textOf(await press(grok.client, "herdr:term-pip", ["enter"]))).toContain("for Grok");
    // A terminal that moves mid-press stops the rest.
    const kai = await press(claude.client, "herdr:term-kai", ["esc", "esc"]);
    expect(textOf(kai)).toContain("Stopped after 1 of 2 keys");
    expect(sent).toHaveLength(7);

    // Each press is on the note board, signed by the app.
    const notes = board.readAppNotes({ limit: 20 });
    expect(notes.outcome === "ready" && notes.notes.map((note) => note.text)).toEqual([
      "Pressed keys in term-bram: ctrl+c.",
      "Pressed keys in term-ivy: down, down, shift+tab, enter.",
      "Pressed keys in dot: esc.",
      "Pressed part of 2 keys in term-kai: esc; stopped because the agent's terminal went away.",
    ]);

    // The relay stamps the app; a caller-named one is refused.
    const forged = await fetch(new URL("/operator/v1/dispatch", relayUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${grok.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "key_press",
        schemaVersion: 1,
        terminalId: "term-bram",
        keys: ["enter"],
        appDeviceId: "someone-else",
      }),
    });
    expect(forged.status).toBe(400);

    // Turning it off stops it at once.
    expect(await owner.run(["prompts", "off", "Claude"])).toBe(0);
    expect(textOf(await press(claude.client, "herdr:term-bram", ["esc"]))).toContain("hasn't turned on");
    expect(sent).toHaveLength(7);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    relay.closeAllConnections();
    relay.close();
    await host.close();
    await rm(boardRoot, { recursive: true, force: true });
  }
}, 30_000);

it("an app reads an agent in Rex, and types or presses keys there only once the owner turns it on (#963)", async () => {
  // Rex itself is never run: a fake `rex` on the service's PATH replays its JSON (fixtures/fake-rex.mjs).
  const session = "session:0a1b2c3d-0000-4000-8000-000000000001";
  const block = "block:0a1b2c3d-0000-4000-8000-0000000000a1";
  const agent = `rex:${session.slice("session:".length)}/${block.slice("block:".length)}`;
  const rex = await fakeRex({
    version: { rex_version: "0.0.1793299046-g2307b7", api_revision: 7, api_min_revision: 0 },
    sessions: [
      {
        session_id: session,
        label: "work",
        blocks: [
          {
            block_id: block,
            creator_name: "com.superlogical.terminal",
            records: [{ state: "idle", app: "opencode" }],
            foreground: { pid: 4101, name: "opencode" },
            capture: "before=secret",
            screen: "before=secret",
            takes: true,
          },
        ],
      },
    ],
  });
  const captainToken = randomBytes(24).toString("hex");
  const serve = createOperatorService({
    shutdown: new AbortController(),
    deps: {},
    personas: { ready: async () => {} },
    settingsStore: {},
    rex: createRex({ env: rex.env, confirmMs: 2_000 }),
  } as unknown as CreateOperatorServiceContext);
  const host = await createQaService({
    captainToken,
    captain: {
      serveOperatorConversation: ((request: Parameters<typeof serve>[0]) => serve(request)) as never,
    },
  });
  const authorizeDevice = new ControlPlaneDeviceAuthorizer({ baseUrl: host.baseUrl });
  let relayUrl = "";
  const operator = createOperatorConversationRelayHandler({
    authorizeDevice,
    dispatch: createCaptainConversationDispatch({ baseUrl: host.baseUrl, bearerToken: captainToken }),
  });
  const connector = createConnectorMcpHandler({
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
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  let client: Client | undefined;
  try {
    const { client_id: clientId } = (await (await register(host.baseUrl, [CALLBACK], "Claude")).json()) as {
      client_id: string;
    };
    const started = await startSignIn(host.baseUrl, clientId, CALLBACK);
    expect(await cli(host).run(["approve", started.code!])).toBe(0);
    const code = new URL((await status(host.baseUrl, started.request!)).redirect!).searchParams.get("code")!;
    const { access_token: accessToken } = (await (
      await token(host.baseUrl, {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code,
        code_verifier: started.verifier,
      })
    ).json()) as { access_token: string };
    client = new Client({ name: "Claude-e2e", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }) as unknown as Transport,
    );
    const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      (result.content as Array<{ text: string }>)[0]!.text;
    const keyed = () => rex.state().then((state) => state.sessions[0]!.blocks[0]!);

    // Reading needs no switch, and holds back what the block showed before (ADR 0307).
    const read = await client.callTool({ name: "read_agent", arguments: { agent } });
    expect(read.isError, textOf(read)).toBeFalsy();
    expect(textOf(read)).not.toContain("before=secret");

    // Typing and keys stay off until the owner turns prompts and keys on for this app.
    const off = await client.callTool({ name: "message_agent", arguments: { agent, message: "Fix it" } });
    expect(off.isError).toBe(true);
    expect(textOf(off)).toContain("hasn't turned on prompts and keys for Claude");
    const keysOff = await client.callTool({ name: "press_keys", arguments: { agent, keys: ["esc"] } });
    expect(textOf(keysOff)).toContain("hasn't turned on prompts and keys for Claude");
    expect(await keyed()).not.toHaveProperty("pasted");
    expect(await keyed()).not.toHaveProperty("keys");

    const owner = cli(host);
    expect(await owner.run(["prompts", "on", "Claude"])).toBe(0);
    const sent = await client.callTool({ name: "message_agent", arguments: { agent, message: "Fix it" } });
    expect(sent.isError).toBeFalsy();
    expect(JSON.parse(textOf(sent))).toMatchObject({ agent, status: "delivered" });
    expect((await keyed()).pasted).toEqual(["Fix it"]);

    // The relay stamps the app; one that names itself is refused.
    const forged = await fetch(new URL("/operator/v1/dispatch", relayUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "rex_send",
        schemaVersion: 1,
        block: agent.slice("rex:".length),
        text: "hi",
        appDeviceId: "x",
      }),
    });
    expect(forged.status).toBe(400);

    // Turned off again, nothing more goes in.
    expect(await owner.run(["prompts", "off", "Claude"])).toBe(0);
    const again = await client.callTool({ name: "press_keys", arguments: { agent, keys: ["enter"] } });
    expect(textOf(again)).toContain("hasn't turned on");
    expect((await keyed()).keys).toEqual(["enter"]);
  } finally {
    await client?.close();
    relay.closeAllConnections();
    relay.close();
    await host.close();
    await rex.close();
  }
}, 30_000);

it("keeps an app's name to characters the owner can read, wherever it is shown", async () => {
  const host = await createQaService();
  try {
    for (const refused of [
      "Cla\u001bude",
      "Cla\nude",
      "Cla\u202Eude",
      "Cla\u200Bude",
      "Cla\u2028ude",
      "Cla\u3164ude",
      "Cla\u{E0041}ude",
      "Cla\uD800ude",
    ]) {
      const response = await register(host.baseUrl, [CALLBACK], refused);
      expect(response.status, JSON.stringify(refused)).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
    }
    // Names that read as the owner, Clankie or a lead are reserved, however they are spelled (#349).
    for (const reserved of [
      "the owner",
      "OWNER",
      "Clankie",
      "clankie!",
      "Clankie on this Mac",
      "Your Lead",
      // The name is checked as it will be stored: cut to 64 characters, then trimmed.
      `the owner${" ".repeat(55)}app`,
      `the operator${" ".repeat(52)}app`,
      // Lookalike letters from other scripts, fullwidth forms, marks, invisibles and digits.
      "cl\u0430nkie",
      "the \u043Ewner",
      "\uFF23\uFF4C\uFF41\uFF4E\uFF4B\uFF49\uFF45",
      "Cla\u0301nkie",
      "the 0wner",
      "\u04C0ead",
    ]) {
      const response = await register(host.baseUrl, [CALLBACK], reserved);
      expect(response.status, reserved).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
    }
    // Ordinary names in any language or with an emoji still register, cut to size.
    for (const accepted of ["Claude Code", "Клод", "クロード", "Grok 🚀", "Clankiest"]) {
      const response = await register(host.baseUrl, [CALLBACK], accepted);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ client_name: accepted });
    }
    // A cut that lands inside an emoji leaves no half of it behind.
    const long = await register(host.baseUrl, [CALLBACK], `${"a".repeat(63)}🚀`);
    expect(((await long.json()) as { client_name: string }).client_name).toBe("a".repeat(63));
  } finally {
    await host.close();
  }
});

it("prints a stored app name without the characters an older sign-in could carry", async () => {
  const stored = "Cla\u001b\nu\u202Ede";
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        signIns: [
          {
            code: "ABCD-2345",
            clientName: stored,
            redirectHost: "claude.ai",
            createdAt: "2026-11-04T00:00:00.000Z",
            expiresAt: "2026-11-04T00:10:00.000Z",
          },
        ],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    let stdout = "";
    await runConnectorCommand([], {
      host: `http://127.0.0.1:${port}`,
      env: { ...process.env, CLANKIE_OPERATOR_TOKEN: "operator-token" },
      stdout: { write: (text: string) => void (stdout += text) },
      stderr: { write: () => {} },
    });
    expect(stdout).toContain("Waiting: ABCD-2345  Claude, sending access to claude.ai.");
  } finally {
    server.close();
  }
});

it("an app signed in under a name from before the reserved names still reads as an app's on the board and in the CLI (#349)", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "clankie-legacy-app-name-"));
  // A device approved before names were reserved keeps the name it was approved under.
  const board = new FleetRoomJournal(boardRoot);
  board.postAppNote("the owner", "Rotate the deploy key.");
  const read = board.readAppNotes({});
  expect(read).toMatchObject({
    outcome: "ready",
    notes: [{ author: "the owner", authorKind: "app", text: "Rotate the deploy key." }],
  });
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ op: "app_notes", schemaVersion: 1, result: read }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    let stdout = "";
    await runConnectorCommand(["notes"], {
      host: `http://127.0.0.1:${port}`,
      env: { ...process.env, CLANKIE_OPERATOR_TOKEN: "operator-token" },
      stdout: { write: (text: string) => void (stdout += text) },
      stderr: { write: () => {} },
    });
    const [head] = stdout.split("\n");
    expect(head).toMatch(/^#1 \S+ the app "the owner"$/u);
  } finally {
    server.close();
    await rm(boardRoot, { recursive: true, force: true });
  }
});

it("still fills to the shared cap for sign-ins that name no requester", async () => {
  const host = await createQaService();
  try {
    const { client_id: clientId } = (await (await register(host.baseUrl)).json()) as { client_id: string };
    const first = await startSignIn(host.baseUrl, clientId);
    for (let index = 1; index < 32; index++) await startSignIn(host.baseUrl, clientId);
    expect((await status(host.baseUrl, first.request!)).status).toBe("pending");
    expect((await startSignIn(host.baseUrl, clientId)).page.status).toBe(429);
  } finally {
    await host.close();
  }
});
