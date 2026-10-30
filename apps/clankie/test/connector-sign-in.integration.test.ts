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
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import type { HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { createPromptAnswerer } from "../src/captain/prompt-answer.ts";
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
