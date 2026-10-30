import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { runConnectorCommand } from "../../tui/src/command/connector.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// The owner hands Clankie's lead to the connected apps (ADR 0304): a real captain
// holds the turns he would have taken himself, the apps read them through the
// relay and the connector, and only the owner hands the lead back.

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const LEAD = "global-default";

it("holds Clankie's own turns for the connected apps while they lead, and only the owner hands the lead back", async () => {
  const root = await mkdtemp(join(tmpdir(), "connected-apps-lead-"));
  let turns = 0;
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      onTurnSettled: () => turns++,
      runtimes: {
        list: async () => [],
        onChange: () => () => undefined,
        configuredBinding: async () => undefined,
      },
      browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
      media: { finishedRenders: async () => [] },
      embodiment: {
        submitIntent: async () => {
          throw new Error("No body in this fixture");
        },
        getSession: async () => undefined,
        getLiveSession: async () => undefined,
      },
      memory: {
        appendEpisode: async () => ({ corrected: false, retained: false }),
        recallEpisodeCard: async () => "",
        searchEpisodeCard: async () => "",
      },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });
  const captainToken = randomBytes(24).toString("hex");
  const host = await createQaService({
    captainToken,
    captain: {
      serveOperatorConversation: (request, owner) => captain.serveOperatorConversation(request, owner),
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
  const cli = async (args: readonly string[]) => {
    let stdout = "";
    let stderr = "";
    const code = await runConnectorCommand(args, {
      host: host.baseUrl,
      env: { ...process.env, CLANKIE_OPERATOR_TOKEN: host.operatorToken },
      stdout: { write: (text: string) => void (stdout += text) },
      stderr: { write: (text: string) => void (stderr += text) },
    });
    return { code, stdout, stderr };
  };
  try {
    // Sign Claude in, approved by the owner at the Mac.
    const { client_id: clientId } = (await (
      await fetch(`${host.baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK] }),
      })
    ).json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const page = await (
      await fetch(
        `${host.baseUrl}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: CALLBACK,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          state: "s",
          scope: "agents offline_access",
        })}`,
      )
    ).text();
    expect((await cli(["approve", /class="code">([A-Z0-9-]+)</u.exec(page)![1]!])).code).toBe(0);
    const decided = (await (
      await fetch(`${host.baseUrl}/oauth/authorize/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: /const id="([^"]+)"/u.exec(page)![1] }),
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
          code: new URL(decided.redirect).searchParams.get("code")!,
          code_verifier: verifier,
        }).toString(),
      })
    ).json()) as { access_token: string };
    client = new Client({ name: "claude-e2e", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }) as unknown as Transport,
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      return { error: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
    };
    const relayDispatch = (body: unknown) =>
      fetch(new URL("/operator/v1/dispatch", relayUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Clankie leads until the owner says otherwise; nothing is held and the reports stay his.
    expect(await cli(["lead"])).toEqual({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("Clankie leads"),
    });
    expect(JSON.parse((await call("read_inbox")).text)).toMatchObject({ lead: "clankie" });
    const notLeading = await call("read_reports", { thread: LEAD });
    expect(notLeading).toMatchObject({ error: true });
    expect(notLeading.text).toContain("connector_not_leading");
    // An app never hands the lead over or back itself.
    for (const lead of ["apps", "clankie"])
      expect(
        (await relayDispatch({ op: "lead", schemaVersion: 1, command: { action: "set", lead } })).status,
      ).toBe(403);

    // The owner hands the lead to the apps; a wake Clankie would have taken is held for them.
    const handed = await cli(["lead", "apps", "--json"]);
    expect(JSON.parse(handed.stdout)).toMatchObject({ ok: true, lead: "apps", held: 0 });
    expect(JSON.parse(await readFile(join(root, "lead.json"), "utf8"))).toMatchObject({ lead: "apps" });
    expect(
      await captain.wakeConversation(
        { conversationId: LEAD },
        "Timer: check on the release branch.",
        undefined,
        "machine",
        false,
      ),
    ).toBe(true);
    await expect.poll(async () => JSON.parse((await call("read_inbox")).text).held.length).toBe(1);
    const inbox = JSON.parse((await call("read_inbox")).text) as {
      lead: string;
      about: string;
      held: Array<{ seq: number; conversationId: string; text: string }>;
      next: number;
    };
    expect(inbox).toMatchObject({ lead: "apps", next: 1 });
    expect(inbox.about).toContain("not the owner's instructions");
    expect(inbox.held).toEqual([
      expect.objectContaining({
        seq: 1,
        conversationId: LEAD,
        text: expect.stringContaining("release branch"),
      }),
    ]);
    expect(turns).toBe(0);
    expect(JSON.parse((await call("read_inbox", { after: inbox.next })).text)).toMatchObject({ held: [] });
    // The lead thread's reports are the apps' to read now; a persona thread's never are.
    expect(JSON.parse((await call("read_reports", { thread: LEAD })).text)).toMatchObject({
      conversationId: LEAD,
      unreadCount: 0,
      items: [],
    });
    expect((await cli(["lead"])).stdout).toContain("(1 held)");

    // Handing the lead back is the owner's: the captain bearer can't, the owner's CLI can.
    const back = await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, host.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${captainToken}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "lead", schemaVersion: 1, command: { action: "set", lead: "clankie" } }),
    });
    expect(back.status).toBe(403);
    expect((await cli(["lead", "clankie"])).stdout).toContain("Clankie leads");
    expect(JSON.parse((await call("read_inbox")).text)).toMatchObject({ lead: "clankie" });
    expect((await call("read_reports", { thread: LEAD })).text).toContain("connector_not_leading");
  } finally {
    await client?.close();
    relay.closeAllConnections();
    relay.close();
    await host.close();
    await captain.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);
