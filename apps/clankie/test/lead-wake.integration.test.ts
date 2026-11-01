import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { FileCredentialStore } from "@clankie/credential-broker";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
import { expect, it } from "vitest";
import { createLeadWakes } from "../src/lead-wakes.ts";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { runConnectorCommand } from "../../tui/src/command/connector.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// Waking a connected lead (ADR 0336) over the real path: the owner stores the lead's
// webhook with `clankie connector wake set` from stdin into the credential broker, a
// connected app signed in through the real OAuth flow hands the lead a job with
// wake_lead through the relay, and the lead's webhook (a real HTTP server here, as
// Grok Bot's routine is on Cursor's) receives only the text and who sent it.

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

async function register(baseUrl: string, clientName: string) {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [CALLBACK] }),
  });
  return ((await response.json()) as { client_id: string }).client_id;
}

async function signInCode(baseUrl: string, clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "s",
    scope: "agents offline_access",
  });
  const html = await (await fetch(`${baseUrl}/oauth/authorize?${query}`)).text();
  return {
    verifier,
    code: /class="code">([A-Z0-9-]+)</u.exec(html)![1]!,
    request: /const id="([^"]+)"/u.exec(html)![1]!,
  };
}

it("the owner stores a lead's webhook once, and a connected app hands the lead a job with only its text", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-wake-"));
  const credentialsFile = join(root, "credentials.json");
  const store = new FileCredentialStore(credentialsFile);
  const key = `rk_${randomBytes(12).toString("hex")}`;
  // The lead's webhook: it takes a job only with its key, and answers like a routine does.
  const received: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }> =
    [];
  let answer = 200;
  const webhook = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: JSON.parse(body) as Record<string, unknown>,
      });
      response.statusCode = request.headers.authorization === `Bearer ${key}` ? answer : 401;
      response.end(JSON.stringify({ routine: "secret-routine-id", ok: true }));
    });
  });
  webhook.listen(0, "127.0.0.1");
  await once(webhook, "listening");
  const hookPath = `/v1/routines/${randomBytes(6).toString("hex")}/fire`;
  const hookUrl = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}${hookPath}`;

  const captainToken = randomBytes(24).toString("hex");
  const host = await createQaService({ captainToken, leadWakes: createLeadWakes({ store }) });
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

  const owner = (args: readonly string[], stdin?: string) => {
    let stdout = "";
    let stderr = "";
    const run = runConnectorCommand(args, {
      host: host.baseUrl,
      env: { ...process.env, CLANKIE_OPERATOR_TOKEN: host.operatorToken },
      credentialStore: store,
      ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) }),
      stdout: { write: (text: string) => void (stdout += text) },
      stderr: { write: (text: string) => void (stderr += text) },
    });
    return run.then((code) => ({ code, stdout, stderr }));
  };
  let client: Client | undefined;
  try {
    // A secret on argv would stay in shell history, so the address and key come on stdin only.
    expect((await owner(["wake", "set", "grok", hookUrl])).code).toBe(2);
    expect((await owner(["wake", "set", "grok"], "ftp://example.com/hook\nabc\n")).code).toBe(1);
    const stored = await owner(["wake", "set", "Grok"], `${hookUrl}\n${key}\n`);
    expect(stored.code).toBe(0);
    expect(stored.stdout).toContain("Stored grok's wake webhook");
    expect(`${stored.stdout}${stored.stderr}`).not.toContain(key);
    expect(`${stored.stdout}${stored.stderr}`).not.toContain(hookPath);
    const listed = await owner(["wake", "--json"]);
    expect(JSON.parse(listed.stdout)).toEqual({ ok: true, leads: ["grok"] });
    // The broker keeps it; the store's own listing never shows it.
    expect(await readFile(credentialsFile, "utf8")).toContain(key);
    expect(JSON.stringify(await store.list())).not.toContain(key);

    // A connected app signs in the real way and the owner approves it.
    const clientId = await register(host.baseUrl, "Claude");
    const started = await signInCode(host.baseUrl, clientId);
    expect((await owner(["approve", started.code])).code).toBe(0);
    const approved = (await (
      await fetch(`${host.baseUrl}/oauth/authorize/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: started.request }),
      })
    ).json()) as { redirect: string };
    const { access_token: accessToken } = (await (
      await fetch(`${host.baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: CALLBACK,
          code: new URL(approved.redirect).searchParams.get("code")!,
          code_verifier: started.verifier,
        }).toString(),
      })
    ).json()) as { access_token: string };
    client = new Client({ name: "claude-e2e", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }) as unknown as Transport,
    );
    const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      (result.content as Array<{ text: string }>)[0]!.text;
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("wake_lead");

    // The job reaches the lead's webhook, signed with the app's approved name; a from
    // argument is no part of the tool.
    const job = "Restart Clankie on the Mac and report health in one line.";
    const sent = await client.callTool({ name: "wake_lead", arguments: { lead: "grok", text: job } });
    expect(sent.isError).toBeFalsy();
    expect(JSON.parse(textOf(sent))).toMatchObject({ outcome: "sent", lead: "grok", status: 200 });
    // The answer names neither the address nor the key, nor the webhook's own reply.
    expect(textOf(sent)).not.toContain(key);
    expect(textOf(sent)).not.toContain(hookPath);
    expect(textOf(sent)).not.toContain("secret-routine-id");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      path: hookPath,
      authorization: `Bearer ${key}`,
      body: { source: "clankie", kind: "lead_wake", lead: "grok", from: "Claude", text: job },
    });
    expect(Object.keys(received[0]!.body).sort()).toEqual(
      ["from", "kind", "lead", "reply", "sentAt", "source", "text"].sort(),
    );

    // A lead with no webhook answers with the names that have one, and nothing is sent.
    const missing = await client.callTool({ name: "wake_lead", arguments: { lead: "codex", text: "hi" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Leads that do: grok");
    expect(received).toHaveLength(1);

    // A webhook that refuses the job is a refusal, by its status only.
    answer = 500;
    const refused = await client.callTool({ name: "wake_lead", arguments: { lead: "grok", text: "ping" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("answered 500");
    answer = 200;

    // Only the relay stamps the app: a caller that names one is refused there and at the service.
    const dispatch = (base: string, bearer: string, body: unknown) =>
      fetch(`${base}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const forged = { op: "lead_wake", schemaVersion: 1, lead: "grok", text: "forged" };
    expect((await dispatch(relayUrl, accessToken, { ...forged, appDeviceId: "x" })).status).toBe(400);
    expect((await dispatch(host.baseUrl, captainToken, forged)).status).toBe(403);
    expect(
      (await dispatch(host.baseUrl, captainToken, { ...forged, appDeviceId: "not-a-device" })).status,
    ).toBe(403);
    expect(received).toHaveLength(2);

    // The owner tries the webhook from the Mac, signed as the owner.
    const tried = await owner(["wake", "send", "grok", "Reply", "with", "one", "line."]);
    expect(tried.code).toBe(0);
    expect(tried.stdout).toContain("Sent.");
    expect(received.at(-1)!.body).toMatchObject({ from: "the owner", text: "Reply with one line." });

    // Forgetting it stops the wakes.
    expect((await owner(["wake", "clear", "grok"])).code).toBe(0);
    expect(JSON.parse((await owner(["wake", "--json"])).stdout)).toEqual({ ok: true, leads: [] });
    const gone = await client.callTool({ name: "wake_lead", arguments: { lead: "grok", text: "hi" } });
    expect(gone.isError).toBe(true);
    expect(textOf(gone)).toContain("clankie connector wake set grok");
    expect(received).toHaveLength(3);
  } finally {
    await client?.close();
    relay.closeAllConnections();
    relay.close();
    webhook.closeAllConnections();
    webhook.close();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
