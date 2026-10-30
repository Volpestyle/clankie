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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetRoomJournal } from "../src/captain/fleet-room.ts";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { runConnectorCommand } from "../../tui/src/command/connector.ts";
import { requestPairingOffer } from "../../tui/bin/pairing-offer.ts";
import { createQaService } from "./fixtures/qa-service.ts";

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
  const host = await createQaService();
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

    // Refresh rotates: the newer token works, the one it replaced doesn't, across a restart.
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
    expect(
      await (
        await token(host.baseUrl, {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: tokens.refresh_token,
        })
      ).json(),
    ).toEqual({ error: "invalid_grant" });
    const afterRestart = await token(host.baseUrl, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: rotated.refresh_token,
    });
    expect(afterRestart.status).toBe(200);
    const latest = (await afterRestart.json()) as { access_token: string; refresh_token: string };

    // Revoking the device in `clankie devices` ends every token it holds.
    expect((await host.operator(`/v1/devices/${self.deviceId}/revoke`)).status).toBe(200);
    expect(
      (
        await fetch(`${host.baseUrl}/v1/devices/self`, {
          headers: { authorization: `Bearer ${latest.access_token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      await (
        await token(host.baseUrl, {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: latest.refresh_token,
        })
      ).json(),
    ).toEqual({ error: "invalid_grant" });

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
    // An author argument is no part of the tool: the board signs with the approved name.
    const posted = await claude.client.callTool({
      name: "post_note",
      arguments: { text: note, author: "Owner" },
    });
    expect(JSON.parse(textOf(posted)).posted).toMatchObject({ author: "Claude", text: note });
    const read = JSON.parse(textOf(await grok.client.callTool({ name: "read_notes", arguments: {} }))) as {
      notes: Array<{ author: string; text: string }>;
      newer: string;
    };
    expect(read.notes).toEqual([{ sequence: 1, at: expect.any(String), author: "Claude", text: note }]);
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
